import { and, eq, inArray, isNull } from "drizzle-orm";
import { withActor } from "@/db/actor";
import type { AppTx } from "@/db/client";
import { category, transaction, transactionSplit } from "@/db/schema";
import { logInfo } from "@/lib/telemetry";
import { UUID, failure, refuse, succeed, type ServiceActor, type ServiceResult, type Via } from "@/lib/service-result";

/**
 * Bulk categorization (PEN-281): many transactions to one category in one
 * household transaction. Only single-category transactions move; split ones
 * are skipped and counted, as when a payee rule is applied. Deleted and
 * unknown ids are counted, not errors, so one stale id does not sink a batch.
 */

export const BULK_CATEGORIZE_MAX_IDS = 500;
const CATEGORY_NOT_HERE = "Choose a category in this household.";

export type BulkCategorizeOutcome = {
  categoryId: string;
  categoryName: string;
  changed: number;
  alreadyThere: number;
  skippedSplit: number;
  skippedWithoutCategory: number;
  notFound: number;
  dryRun: boolean;
  /** Up to 10 changed transactions, so the result can be checked. */
  samples: Array<{ id: string; payee: string; amountCents: number }>;
};

type Candidate = { id: string; payee: string; amountCents: number; splits: { categoryId: string; amountCents: number }[] };

async function loadCandidates(tx: AppTx, householdId: string, ids: readonly string[]): Promise<Candidate[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({ id: transaction.id, payee: transaction.payee, amountCents: transaction.amountCents })
    .from(transaction)
    .where(and(eq(transaction.householdId, householdId), isNull(transaction.deletedAt), inArray(transaction.id, [...ids])))
    .for("update");
  const splitRows = rows.length
    ? await tx
        .select({ transactionId: transactionSplit.transactionId, categoryId: transactionSplit.categoryId, amountCents: transactionSplit.amountCents })
        .from(transactionSplit)
        .where(and(eq(transactionSplit.householdId, householdId), inArray(transactionSplit.transactionId, rows.map((row) => row.id))))
    : [];
  return rows.map((row) => ({
    ...row,
    splits: splitRows.filter((split) => split.transactionId === row.id).map((split) => ({ categoryId: split.categoryId, amountCents: split.amountCents })),
  }));
}

async function applyCategory(
  tx: AppTx,
  householdId: string,
  categoryId: string,
  categoryName: string,
  candidates: readonly Candidate[],
  requested: number,
  dryRun: boolean,
): Promise<BulkCategorizeOutcome> {
  const move: Candidate[] = [];
  let alreadyThere = 0;
  let skippedSplit = 0;
  let skippedWithoutCategory = 0;
  for (const item of candidates) {
    if (item.splits.length > 1) skippedSplit += 1;
    else if (item.splits.length === 0) skippedWithoutCategory += 1;
    else if (item.splits[0]?.categoryId === categoryId) alreadyThere += 1;
    else move.push(item);
  }
  if (!dryRun && move.length > 0) {
    const ids = move.map((item) => item.id);
    await tx.delete(transactionSplit).where(and(eq(transactionSplit.householdId, householdId), inArray(transactionSplit.transactionId, ids)));
    await tx.insert(transactionSplit).values(
      move.map((item) => ({ transactionId: item.id, householdId, categoryId, amountCents: item.amountCents })),
    );
  }
  return {
    categoryId,
    categoryName,
    changed: move.length,
    alreadyThere,
    skippedSplit,
    skippedWithoutCategory,
    notFound: requested - candidates.length,
    dryRun,
    samples: move.slice(0, 10).map((item) => ({ id: item.id, payee: item.payee, amountCents: item.amountCents })),
  };
}

async function categoryNameFor(tx: AppTx, householdId: string, categoryId: string): Promise<string> {
  const [row] = await tx
    .select({ name: category.name })
    .from(category)
    .where(and(eq(category.id, categoryId), eq(category.householdId, householdId)));
  if (!row) throw new Error(CATEGORY_NOT_HERE);
  return row.name;
}

/** Put these transactions in one category. */
export async function categorizeTransactions(
  actor: ServiceActor,
  input: { transactionIds: readonly string[]; categoryId: string; dryRun?: boolean },
  via: Via = "web",
): Promise<ServiceResult<BulkCategorizeOutcome>> {
  const ids = [...new Set(input.transactionIds)];
  if (ids.length === 0) return refuse("Choose at least one transaction.");
  if (ids.length > BULK_CATEGORIZE_MAX_IDS) return refuse(`Categorize up to ${BULK_CATEGORIZE_MAX_IDS} transactions at a time.`);
  if (!UUID.test(input.categoryId)) return refuse(CATEGORY_NOT_HERE);
  const valid = ids.filter((id) => UUID.test(id));
  try {
    const outcome = await withActor(actor.userId, async (tx) => {
      const name = await categoryNameFor(tx, actor.householdId, input.categoryId);
      const candidates = await loadCandidates(tx, actor.householdId, valid);
      return applyCategory(tx, actor.householdId, input.categoryId, name, candidates, ids.length, input.dryRun === true);
    });
    if (!outcome.dryRun) logInfo("Transactions categorized", { action: "categorize-transactions", via, householdId: actor.householdId, changed: String(outcome.changed) });
    return succeed(outcome);
  } catch (error) {
    return failure(error, "Could not categorize those transactions.", { action: "categorize-transactions", via, householdId: actor.householdId }, [CATEGORY_NOT_HERE]);
  }
}

/** Put every existing transaction with this payee in one category, without making a rule. */
export async function categorizeByPayee(
  actor: ServiceActor,
  input: { payee: string; match: "exact" | "contains"; categoryId: string; dryRun?: boolean },
  via: Via = "web",
): Promise<ServiceResult<BulkCategorizeOutcome>> {
  const needle = input.payee.trim().toLowerCase();
  if (needle.length === 0) return refuse("Enter the payee to match.");
  if (!UUID.test(input.categoryId)) return refuse(CATEGORY_NOT_HERE);
  try {
    const outcome = await withActor(actor.userId, async (tx) => {
      const name = await categoryNameFor(tx, actor.householdId, input.categoryId);
      const all = await tx
        .select({ id: transaction.id, payee: transaction.payee })
        .from(transaction)
        .where(and(eq(transaction.householdId, actor.householdId), isNull(transaction.deletedAt)));
      const ids = all
        .filter((row) => {
          const payee = row.payee.trim().toLowerCase();
          return input.match === "exact" ? payee === needle : payee.includes(needle);
        })
        .map((row) => row.id);
      const candidates = await loadCandidates(tx, actor.householdId, ids);
      return applyCategory(tx, actor.householdId, input.categoryId, name, candidates, ids.length, input.dryRun === true);
    });
    if (!outcome.dryRun) logInfo("Payee categorized", { action: "categorize-by-payee", via, householdId: actor.householdId, changed: String(outcome.changed) });
    return succeed(outcome);
  } catch (error) {
    return failure(error, "Could not categorize that payee.", { action: "categorize-by-payee", via, householdId: actor.householdId }, [CATEGORY_NOT_HERE]);
  }
}
