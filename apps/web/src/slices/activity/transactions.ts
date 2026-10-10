import {
  TransactionError,
  accountAcceptsCorrection,
  accountAcceptsNewEntry,
  amendTransactionEntry,
  defineTransactionEntry,
  deleteTransaction,
  isIsoDate,
  restoreTransaction,
  type TransactionEntry,
  type TransactionEntryInput,
  type TransactionEntryPatch,
} from "@dollas/domain";
import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, type SQL } from "drizzle-orm";
import { withActor } from "@/db/actor";
import type { AppTx } from "@/db/client";
import { category, categoryGroup, ledgerAccount, transaction, transactionSplit } from "@/db/schema";
import { logInfo } from "@/lib/telemetry";
import { UUID, failure, refuse, succeed, type ServiceActor, type ServiceResult, type Via } from "@/lib/service-result";

/**
 * Transaction services shared by the Activity page actions and MCP tools.
 * Amounts are signed integer cents; negative is money out.
 */

const NOT_HERE = "That transaction is not in this household.";
const KNOWN = [NOT_HERE, "Choose categories from this household."];

export type ListedTransaction = {
  id: string;
  occurredOn: string;
  payee: string;
  amountCents: number;
  accountId: string;
  accountName: string;
  accountArchived: boolean;
  deleted: boolean;
  splits: Array<{ categoryId: string; categoryName: string; amountCents: number }>;
};

export type TransactionFilter = {
  limit: number;
  offset: number;
  accountId?: string;
  categoryId?: string;
  from?: string;
  to?: string;
  payeeContains?: string;
  /** Deleted transactions, so they can be restored. */
  deletedOnly?: boolean;
};

export type TransactionPage = { items: ListedTransaction[]; total: number };

function categoryLabel(name: string, groupName: string | null): string {
  return groupName ? `${groupName} · ${name}` : name;
}

/** Newest first, then payee. Used by the Activity page (first page) and list_transactions. */
export async function listHouseholdTransactions(
  actor: ServiceActor,
  filter: TransactionFilter,
): Promise<ServiceResult<TransactionPage>> {
  if (filter.from && !isIsoDate(filter.from)) return refuse("Use a from date like 2026-01-01.");
  if (filter.to && !isIsoDate(filter.to)) return refuse("Use a to date like 2026-01-31.");
  if (filter.accountId && !UUID.test(filter.accountId)) return succeed({ items: [], total: 0 });
  if (filter.categoryId && !UUID.test(filter.categoryId)) return succeed({ items: [], total: 0 });
  try {
    return succeed(
      await withActor(actor.userId, async (tx) => {
        const where: SQL[] = [eq(transaction.householdId, actor.householdId)];
        where.push(filter.deletedOnly ? isNotNull(transaction.deletedAt) : isNull(transaction.deletedAt));
        if (filter.accountId) where.push(eq(transaction.accountId, filter.accountId));
        if (filter.from) where.push(gte(transaction.occurredOn, filter.from));
        if (filter.to) where.push(lte(transaction.occurredOn, filter.to));
        if (filter.payeeContains) {
          where.push(ilike(transaction.payee, `%${filter.payeeContains.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
        }
        if (filter.categoryId) {
          const tagged = tx
            .select({ id: transactionSplit.transactionId })
            .from(transactionSplit)
            .where(and(eq(transactionSplit.householdId, actor.householdId), eq(transactionSplit.categoryId, filter.categoryId)));
          where.push(inArray(transaction.id, tagged));
        }
        const matching = and(...where);
        const [counted] = await tx.select({ value: count() }).from(transaction).where(matching);
        const rows = await tx
          .select({
            id: transaction.id,
            occurredOn: transaction.occurredOn,
            payee: transaction.payee,
            amountCents: transaction.amountCents,
            accountId: transaction.accountId,
            accountName: ledgerAccount.name,
            accountArchivedAt: ledgerAccount.archivedAt,
            deletedAt: transaction.deletedAt,
          })
          .from(transaction)
          .innerJoin(ledgerAccount, eq(ledgerAccount.id, transaction.accountId))
          .where(matching)
          .orderBy(desc(transaction.occurredOn), asc(transaction.payee), asc(transaction.id))
          .limit(filter.limit)
          .offset(filter.offset);
        const ids = rows.map((row) => row.id);
        const splits =
          ids.length === 0
            ? []
            : await tx
                .select({
                  transactionId: transactionSplit.transactionId,
                  categoryId: transactionSplit.categoryId,
                  categoryName: category.name,
                  groupName: categoryGroup.name,
                  amountCents: transactionSplit.amountCents,
                })
                .from(transactionSplit)
                .innerJoin(category, eq(category.id, transactionSplit.categoryId))
                .leftJoin(categoryGroup, eq(categoryGroup.id, category.groupId))
                .where(and(eq(transactionSplit.householdId, actor.householdId), inArray(transactionSplit.transactionId, ids)));
        const byTransaction = new Map<string, ListedTransaction["splits"]>();
        for (const split of splits) {
          const list = byTransaction.get(split.transactionId) ?? [];
          list.push({
            categoryId: split.categoryId,
            categoryName: categoryLabel(split.categoryName, split.groupName),
            amountCents: split.amountCents,
          });
          byTransaction.set(split.transactionId, list);
        }
        return {
          total: Number(counted?.value ?? 0),
          items: rows.map((row) => ({
            id: row.id,
            occurredOn: row.occurredOn,
            payee: row.payee,
            amountCents: row.amountCents,
            accountId: row.accountId,
            accountName: row.accountName,
            accountArchived: row.accountArchivedAt !== null,
            deleted: row.deletedAt !== null,
            splits: byTransaction.get(row.id) ?? [],
          })),
        };
      }),
    );
  } catch (error) {
    return failure(error, "Could not load transactions. Try again.", { action: "list-transactions", householdId: actor.householdId });
  }
}

async function requireHouseholdTargets(
  tx: AppTx,
  householdId: string,
  entry: TransactionEntry,
  placement: { kind: "new" } | { kind: "correction"; currentAccountId: string },
): Promise<void> {
  const [accountRow] = UUID.test(entry.accountId)
    ? await tx
        .select({ id: ledgerAccount.id, householdId: ledgerAccount.householdId, archivedAt: ledgerAccount.archivedAt })
        .from(ledgerAccount)
        .where(and(eq(ledgerAccount.id, entry.accountId), eq(ledgerAccount.householdId, householdId)))
    : [];
  const account = accountRow
    ? { id: accountRow.id, householdId: accountRow.householdId, archivedAt: accountRow.archivedAt ? accountRow.archivedAt.toISOString() : null }
    : null;
  const accepted =
    placement.kind === "new"
      ? accountAcceptsNewEntry(account, householdId)
      : accountAcceptsCorrection(account, householdId, placement.currentAccountId);
  if (accepted.isErr()) throw accepted.error;
  const known = await tx.select({ id: category.id }).from(category).where(eq(category.householdId, householdId));
  const knownIds = new Set(known.map((row) => row.id));
  if (entry.splits.some((split) => !knownIds.has(split.categoryId))) {
    throw new Error("Choose categories from this household.");
  }
}

function correctionMessage(error: unknown, fallback: string, attributes: Record<string, string>): ServiceResult<never> {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const message = error instanceof Error ? error.message : "";
  if (`${message} ${cause}`.includes("category splits must add up")) {
    return refuse("Category splits must add up to the transaction amount.", error);
  }
  return failure(error, fallback, attributes, KNOWN);
}

export type SavedTransaction = TransactionEntry & { id: string };

export async function createHouseholdTransaction(
  actor: ServiceActor,
  input: TransactionEntryInput,
  via: Via = "web",
): Promise<ServiceResult<SavedTransaction>> {
  const defined = defineTransactionEntry(input);
  if (defined.isErr()) return refuse(defined.error.message, defined.error);
  const entry = defined.value;
  try {
    const id = await withActor(actor.userId, async (tx) => {
      await requireHouseholdTargets(tx, actor.householdId, entry, { kind: "new" });
      const [row] = await tx
        .insert(transaction)
        .values({
          householdId: actor.householdId,
          accountId: entry.accountId,
          occurredOn: entry.occurredOn,
          payee: entry.payee,
          amountCents: entry.amountCents,
        })
        .returning({ id: transaction.id });
      if (!row) throw new Error("transaction insert returned no row");
      await tx.insert(transactionSplit).values(
        entry.splits.map((split) => ({
          transactionId: row.id,
          householdId: actor.householdId,
          categoryId: split.categoryId,
          amountCents: split.amountCents,
        })),
      );
      return row.id;
    });
    logInfo("Transaction added", { action: "create-transaction", via, householdId: actor.householdId });
    return succeed({ id, ...entry });
  } catch (error) {
    return failure(error, "Could not save that transaction.", { action: "create-transaction", via, householdId: actor.householdId }, KNOWN);
  }
}

async function loadEntry(tx: AppTx, householdId: string, transactionId: string): Promise<TransactionEntryInput> {
  const [existing] = await tx
    .select({
      payee: transaction.payee,
      occurredOn: transaction.occurredOn,
      accountId: transaction.accountId,
      amountCents: transaction.amountCents,
      deletedAt: transaction.deletedAt,
    })
    .from(transaction)
    .where(and(eq(transaction.id, transactionId), eq(transaction.householdId, householdId)))
    .for("update");
  if (!existing || existing.deletedAt) throw new Error(NOT_HERE);
  const splits = await tx
    .select({ categoryId: transactionSplit.categoryId, amountCents: transactionSplit.amountCents })
    .from(transactionSplit)
    .where(and(eq(transactionSplit.transactionId, transactionId), eq(transactionSplit.householdId, householdId)));
  return { payee: existing.payee, occurredOn: existing.occurredOn, accountId: existing.accountId, amountCents: existing.amountCents, splits };
}

/**
 * Edits one transaction: payee, date, account, amount, and categories or
 * splits. A full replacement from the Edit form or a partial patch from a
 * tool both land here. Payee rules stay as they are.
 */
export async function amendHouseholdTransaction(
  actor: ServiceActor,
  transactionId: string,
  patch: TransactionEntryPatch,
  via: Via = "web",
): Promise<ServiceResult<SavedTransaction>> {
  if (!UUID.test(transactionId)) return refuse(NOT_HERE);
  try {
    const entry = await withActor(actor.userId, async (tx) => {
      const current = await loadEntry(tx, actor.householdId, transactionId);
      const amended = amendTransactionEntry(current, patch);
      if (amended.isErr()) throw amended.error;
      const next = amended.value;
      await requireHouseholdTargets(tx, actor.householdId, next, { kind: "correction", currentAccountId: current.accountId });
      const updated = await tx
        .update(transaction)
        .set({ accountId: next.accountId, occurredOn: next.occurredOn, payee: next.payee, amountCents: next.amountCents })
        .where(and(eq(transaction.id, transactionId), eq(transaction.householdId, actor.householdId), isNull(transaction.deletedAt)))
        .returning({ id: transaction.id });
      if (updated.length === 0) throw new Error(NOT_HERE);
      // Replaced in this transaction so the deferred balance trigger sees the final set.
      await tx
        .delete(transactionSplit)
        .where(and(eq(transactionSplit.transactionId, transactionId), eq(transactionSplit.householdId, actor.householdId)));
      await tx.insert(transactionSplit).values(
        next.splits.map((split) => ({
          transactionId,
          householdId: actor.householdId,
          categoryId: split.categoryId,
          amountCents: split.amountCents,
        })),
      );
      return next;
    });
    logInfo("Transaction edited", { action: "update-transaction", via, householdId: actor.householdId });
    return succeed({ id: transactionId, ...entry });
  } catch (error) {
    return correctionMessage(error, "Could not save that transaction.", {
      action: "update-transaction",
      via,
      householdId: actor.householdId,
      transactionId,
    });
  }
}

async function loadStored(tx: AppTx, householdId: string, transactionId: string) {
  const [row] = await tx
    .select({
      id: transaction.id,
      householdId: transaction.householdId,
      importFingerprint: transaction.importFingerprint,
      deletedAt: transaction.deletedAt,
      payee: transaction.payee,
    })
    .from(transaction)
    .where(and(eq(transaction.id, transactionId), eq(transaction.householdId, householdId)));
  if (!row) return null;
  return {
    id: row.id,
    householdId: row.householdId,
    importFingerprint: row.importFingerprint,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    payee: row.payee,
  };
}

/** Soft delete. The row stays (restorable) and its import fingerprint keeps re-imports out. */
export async function deleteHouseholdTransaction(
  actor: ServiceActor,
  transactionId: string,
  via: Via = "web",
): Promise<ServiceResult<{ id: string; payee: string }>> {
  if (!UUID.test(transactionId)) return refuse(NOT_HERE);
  try {
    const payee = await withActor(actor.userId, async (tx) => {
      const current = await loadStored(tx, actor.householdId, transactionId);
      const decision = deleteTransaction(current, actor.householdId, new Date().toISOString());
      if (decision.isErr()) throw decision.error;
      const stamp = decision.value.deletedAt;
      if (!stamp || !current) throw new TransactionError("Could not delete that transaction.");
      await tx
        .update(transaction)
        .set({ deletedAt: new Date(stamp) })
        .where(and(eq(transaction.id, transactionId), eq(transaction.householdId, actor.householdId)));
      return current.payee;
    });
    logInfo("Transaction deleted", { action: "delete-transaction", via, householdId: actor.householdId });
    return succeed({ id: transactionId, payee });
  } catch (error) {
    return failure(error, "Could not delete that transaction.", { action: "delete-transaction", via, householdId: actor.householdId, transactionId });
  }
}

export async function restoreHouseholdTransaction(
  actor: ServiceActor,
  transactionId: string,
  via: Via = "web",
): Promise<ServiceResult<{ id: string; payee: string }>> {
  if (!UUID.test(transactionId)) return refuse(NOT_HERE);
  try {
    const payee = await withActor(actor.userId, async (tx) => {
      const current = await loadStored(tx, actor.householdId, transactionId);
      const decision = restoreTransaction(current, actor.householdId);
      if (decision.isErr()) throw decision.error;
      await tx
        .update(transaction)
        .set({ deletedAt: null })
        .where(and(eq(transaction.id, transactionId), eq(transaction.householdId, actor.householdId)));
      return current?.payee ?? "";
    });
    logInfo("Transaction restored", { action: "restore-transaction", via, householdId: actor.householdId });
    return succeed({ id: transactionId, payee });
  } catch (error) {
    return failure(error, "Could not restore that transaction.", { action: "restore-transaction", via, householdId: actor.householdId, transactionId });
  }
}
