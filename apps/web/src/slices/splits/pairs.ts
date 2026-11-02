import {
  SplitGroupError,
  TRANSFER_PAIR_COPY,
  TRANSFER_PAIR_WINDOW_DAYS,
  decideTransferLink,
  rankTransferCandidates,
  shiftCivilDate,
  type TransferDepositFacts,
  type TransferLineFacts,
} from "@dollas/domain";
import { and, asc, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { withActor } from "@/db/actor";
import type { AppTx } from "@/db/client";
import { category, ledgerAccount, transaction, transactionSplit, transferPair } from "@/db/schema";
import { logInfo } from "@/lib/telemetry";
import { UUID, failure, refuse, succeed, type ServiceActor, type ServiceResult, type Via } from "@/lib/service-result";
import { notSplitRow } from "./counted";
import { loadSplitViews, type LinkedDepositView } from "./store";

/**
 * Transfer pairs (PEN-349): a paycheck's net-pay line linked to the deposit
 * the bank (or a CSV) already has in the destination account. Linking gives
 * the deposit the line's transfer category, saving its old category lines;
 * unlinking (or anything that removes the line or the pair) gives them back
 * (restore_transfer_pair_deposit). Suggestions never link on their own.
 */

export const PAIR_NOT_HERE = "That transaction is not in this household.";
export const PAIR_NOT_LINKED = "That transaction is not linked to a deposit.";
export const PAIR_LINE_HAS_DEPOSIT = "A linked line can't also make a new deposit. Choose one.";
const KNOWN = [PAIR_NOT_HERE, PAIR_NOT_LINKED, PAIR_LINE_HAS_DEPOSIT, TRANSFER_PAIR_COPY.depositLocked];

function textOf(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" ");
}

/** Pair checks from the database, in words a member can act on; anything else comes back unchanged. */
export function translatePairError(error: unknown): unknown {
  const text = textOf(error);
  if (text.includes("transfer_pair_deposit_idx")) return new SplitGroupError("That deposit is already linked to another paycheck.");
  if (text.includes("transfer_pair_line_idx")) return new SplitGroupError("That line is already linked to a deposit. Unlink it first.");
  if (text.includes("a linked deposit must mirror its line") || text.includes("a transfer pair deposit is not part of a split"))
    return new SplitGroupError(TRANSFER_PAIR_COPY.depositLocked);
  if (text.includes("a linked line has no deposit of its own")) return new SplitGroupError(PAIR_LINE_HAS_DEPOSIT);
  if (text.includes("a transfer pair links a transfer line")) return new SplitGroupError("A linked line keeps a transfer category. Unlink it first to change that.");
  if (text.includes("a transfer pair links a paycheck line") || text.includes("a transfer pair links a split line"))
    return new SplitGroupError("Link a deposit to a line of a paycheck split.");
  if (text.includes("a transfer pair stays in one household")) return new SplitGroupError(PAIR_NOT_HERE);
  return error;
}

export const PAIR_KNOWN = KNOWN;

async function lineFacts(tx: AppTx, householdId: string, lineId: string): Promise<(TransferLineFacts & { categories: { categoryId: string; amountCents: number }[] }) | null> {
  if (!UUID.test(lineId)) return null;
  const [row] = await tx
    .select({
      id: transaction.id,
      householdId: transaction.householdId,
      accountId: transaction.accountId,
      occurredOn: transaction.occurredOn,
      amountCents: transaction.amountCents,
      parentId: transaction.splitParentId,
      lineId: transaction.splitLineId,
      deletedAt: transaction.deletedAt,
    })
    .from(transaction)
    .where(and(eq(transaction.id, lineId), eq(transaction.householdId, householdId)))
    .for("update");
  if (!row) return null;
  const [parent] = row.parentId
    ? await tx
        .select({ kind: transaction.splitKind, deletedAt: transaction.deletedAt })
        .from(transaction)
        .where(and(eq(transaction.id, row.parentId), eq(transaction.householdId, householdId)))
    : [];
  const categories = await tx
    .select({ categoryId: transactionSplit.categoryId, amountCents: transactionSplit.amountCents, kind: category.kind })
    .from(transactionSplit)
    .innerJoin(category, eq(category.id, transactionSplit.categoryId))
    .where(and(eq(transactionSplit.householdId, householdId), eq(transactionSplit.transactionId, row.id)));
  const [pair] = await tx.select({ depositId: transferPair.depositId }).from(transferPair).where(eq(transferPair.lineId, row.id));
  return {
    id: row.id,
    householdId: row.householdId,
    accountId: row.accountId,
    occurredOn: row.occurredOn,
    amountCents: row.amountCents,
    incomeLine: row.lineId == null && row.parentId != null && parent?.kind === "income" && !parent.deletedAt && !row.deletedAt,
    transferOnly: categories.length > 0 && categories.every((item) => item.kind === "transfer"),
    linkedDepositId: pair?.depositId ?? null,
    categories: categories.map((item) => ({ categoryId: item.categoryId, amountCents: item.amountCents })),
  };
}

async function depositFacts(tx: AppTx, householdId: string, depositId: string): Promise<TransferDepositFacts | null> {
  if (!UUID.test(depositId)) return null;
  const [row] = await tx
    .select({
      id: transaction.id,
      householdId: transaction.householdId,
      accountId: transaction.accountId,
      occurredOn: transaction.occurredOn,
      amountCents: transaction.amountCents,
      deletedAt: transaction.deletedAt,
      splitKind: transaction.splitKind,
      splitParentId: transaction.splitParentId,
      splitReplacedBy: transaction.splitReplacedBy,
    })
    .from(transaction)
    .where(and(eq(transaction.id, depositId), eq(transaction.householdId, householdId)))
    .for("update");
  if (!row) return null;
  const [pair] = await tx
    .select({ lineId: transferPair.lineId, depositId: transferPair.depositId })
    .from(transferPair)
    .where(or(eq(transferPair.depositId, row.id), eq(transferPair.lineId, row.id)));
  return {
    id: row.id,
    householdId: row.householdId,
    accountId: row.accountId,
    occurredOn: row.occurredOn,
    amountCents: row.amountCents,
    deleted: row.deletedAt !== null,
    splitRow: row.splitKind != null || row.splitParentId != null || row.splitReplacedBy != null,
    linkedLineId: pair?.lineId ?? null,
  };
}

/** Links a net-pay line to a deposit inside the caller's transaction. */
export async function linkInTx(tx: AppTx, householdId: string, lineId: string, depositId: string): Promise<"linked" | "exists"> {
  const line = await lineFacts(tx, householdId, lineId);
  const deposit = await depositFacts(tx, householdId, depositId);
  const decided = decideTransferLink(line, deposit, householdId);
  if (decided.isErr()) throw decided.error;
  if (decided.value === "exists" || !line || !deposit) return "exists";
  // A line linked to the bank's deposit no longer makes one of its own.
  await tx.delete(transaction).where(and(eq(transaction.householdId, householdId), eq(transaction.splitLineId, line.id)));
  const prior = await tx
    .select({ categoryId: transactionSplit.categoryId, amountCents: transactionSplit.amountCents })
    .from(transactionSplit)
    .where(and(eq(transactionSplit.householdId, householdId), eq(transactionSplit.transactionId, deposit.id)))
    .orderBy(asc(transactionSplit.id));
  await tx.delete(transactionSplit).where(and(eq(transactionSplit.householdId, householdId), eq(transactionSplit.transactionId, deposit.id)));
  await tx
    .insert(transactionSplit)
    .values(line.categories.map((item) => ({ transactionId: deposit.id, householdId, categoryId: item.categoryId, amountCents: -item.amountCents })));
  await tx.insert(transferPair).values({ householdId, lineId: line.id, depositId: deposit.id, priorCategories: prior });
  return "linked";
}

export type TransferPairView = {
  lineId: string;
  parentId: string;
  parentPayee: string;
  deposit: LinkedDepositView;
};

async function pairViewFor(tx: AppTx, householdId: string, lineId: string): Promise<TransferPairView> {
  const [line] = await tx
    .select({ parentId: transaction.splitParentId })
    .from(transaction)
    .where(and(eq(transaction.id, lineId), eq(transaction.householdId, householdId)));
  const parentId = line?.parentId ?? "";
  const view = (await loadSplitViews(tx, householdId, [parentId])).get(parentId);
  const linked = view?.lines.find((item) => item.id === lineId)?.linked;
  if (!view || !linked) throw new SplitGroupError(PAIR_NOT_LINKED);
  return { lineId, parentId, parentPayee: view.payee, deposit: linked };
}

export async function linkTransfer(
  actor: ServiceActor,
  input: { lineTransactionId: string; depositTransactionId: string },
  via: Via = "web",
): Promise<ServiceResult<TransferPairView & { status: "linked" | "exists" }>> {
  if (!UUID.test(input.lineTransactionId) || !UUID.test(input.depositTransactionId)) return refuse(PAIR_NOT_HERE);
  try {
    const outcome = await withActor(actor.userId, async (tx) => {
      const status = await linkInTx(tx, actor.householdId, input.lineTransactionId, input.depositTransactionId);
      return { status, view: await pairViewFor(tx, actor.householdId, input.lineTransactionId) };
    });
    if (outcome.status === "linked") logInfo("Net pay linked to deposit", { action: "link-transfer", via, householdId: actor.householdId });
    return succeed({ ...outcome.view, status: outcome.status });
  } catch (error) {
    return failure(translatePairError(error), "Could not link that deposit.", { action: "link-transfer", via, householdId: actor.householdId }, KNOWN);
  }
}

/** Unlinks by either side. The deposit gets its old category lines back. */
export async function unlinkTransfer(
  actor: ServiceActor,
  transactionId: string,
  via: Via = "web",
): Promise<ServiceResult<{ lineId: string; depositId: string; restoredCategories: boolean }>> {
  if (!UUID.test(transactionId)) return refuse(PAIR_NOT_HERE);
  try {
    const outcome = await withActor(actor.userId, async (tx) => {
      const [pair] = await tx
        .delete(transferPair)
        .where(and(eq(transferPair.householdId, actor.householdId), or(eq(transferPair.lineId, transactionId), eq(transferPair.depositId, transactionId))))
        .returning({ lineId: transferPair.lineId, depositId: transferPair.depositId, prior: transferPair.priorCategories });
      if (!pair) throw new SplitGroupError(PAIR_NOT_LINKED);
      const now = await tx
        .select({ categoryId: transactionSplit.categoryId, amountCents: transactionSplit.amountCents })
        .from(transactionSplit)
        .where(and(eq(transactionSplit.householdId, actor.householdId), eq(transactionSplit.transactionId, pair.depositId)));
      const key = (rows: readonly { categoryId: string; amountCents: number }[]) =>
        rows
          .map((row) => `${row.categoryId}:${row.amountCents}`)
          .sort()
          .join("|");
      return { lineId: pair.lineId, depositId: pair.depositId, restoredCategories: pair.prior.length > 0 && key(now) === key(pair.prior) };
    });
    logInfo("Net pay unlinked", { action: "unlink-transfer", via, householdId: actor.householdId });
    return succeed(outcome);
  } catch (error) {
    return failure(translatePairError(error), "Could not unlink that deposit.", { action: "unlink-transfer", via, householdId: actor.householdId, transactionId }, KNOWN);
  }
}

export type TransferSuggestion = {
  lineId: string;
  linePayee: string;
  lineAmountCents: number;
  occurredOn: string;
  linked: LinkedDepositView | null;
  candidates: { id: string; accountId: string; accountName: string; occurredOn: string; payee: string; amountCents: number; daysApart: number }[];
};

type CandidateRow = { id: string; accountId: string; accountName: string; occurredOn: string; payee: string; amountCents: number };

/** Unlinked deposits in other accounts near a date: not deleted, not part of a split, not linked yet. */
async function openDeposits(tx: AppTx, householdId: string, from: string, to: string, amounts: readonly number[] | null, excludeAccountId: string): Promise<CandidateRow[]> {
  const where = [
    eq(transaction.householdId, householdId),
    isNull(transaction.deletedAt),
    isNull(transaction.splitReplacedBy),
    notSplitRow(),
    gte(transaction.occurredOn, from),
    lte(transaction.occurredOn, to),
    ne(transaction.accountId, excludeAccountId),
    sql`${transaction.amountCents} > 0`,
    sql`not exists (select 1 from transfer_pair where transfer_pair.deposit_id = ${transaction.id})`,
  ];
  if (amounts) where.push(inArray(transaction.amountCents, amounts.length > 0 ? [...amounts] : [0]));
  return tx
    .select({
      id: transaction.id,
      accountId: transaction.accountId,
      accountName: ledgerAccount.name,
      occurredOn: transaction.occurredOn,
      payee: transaction.payee,
      amountCents: transaction.amountCents,
    })
    .from(transaction)
    .innerJoin(ledgerAccount, eq(ledgerAccount.id, transaction.accountId))
    .where(and(...where))
    .orderBy(asc(transaction.occurredOn), asc(transaction.id))
    .limit(200);
}

function dayGap(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

async function parentIdFor(tx: AppTx, householdId: string, transactionId: string): Promise<string> {
  const [row] = await tx
    .select({ id: transaction.id, parentId: transaction.splitParentId, kind: transaction.splitKind })
    .from(transaction)
    .where(and(eq(transaction.id, transactionId), eq(transaction.householdId, householdId)));
  if (!row) throw new SplitGroupError(PAIR_NOT_HERE);
  return row.parentId ?? row.id;
}

/**
 * For each transfer line on a paycheck split: deposits for the same amount in
 * another account within the bank-match window, nearest first. Read-only; a
 * member or agent links one with link_transfer.
 */
export async function suggestTransferLinks(actor: ServiceActor, transactionId: string): Promise<ServiceResult<{ parentId: string; lines: TransferSuggestion[] }>> {
  if (!UUID.test(transactionId)) return refuse(PAIR_NOT_HERE);
  try {
    return succeed(
      await withActor(actor.userId, async (tx) => {
        const parentId = await parentIdFor(tx, actor.householdId, transactionId);
        const view = (await loadSplitViews(tx, actor.householdId, [parentId])).get(parentId);
        if (!view || view.kind !== "income") throw new SplitGroupError("Suggestions are for paycheck splits.");
        const lines = view.lines.filter((line) => line.categoryKind === "transfer" && (transactionId === parentId || line.id === transactionId));
        if (lines.length === 0) return { parentId, lines: [] };
        const rows = await openDeposits(
          tx,
          actor.householdId,
          shiftCivilDate(view.occurredOn, -TRANSFER_PAIR_WINDOW_DAYS),
          shiftCivilDate(view.occurredOn, TRANSFER_PAIR_WINDOW_DAYS),
          [...new Set(lines.map((line) => -line.amountCents))],
          view.accountId,
        );
        return {
          parentId,
          lines: lines.map((line) => ({
            lineId: line.id,
            linePayee: line.payee,
            lineAmountCents: line.amountCents,
            occurredOn: view.occurredOn,
            linked: line.linked,
            candidates: line.linked
              ? []
              : rankTransferCandidates(
                  { accountId: view.accountId, occurredOn: view.occurredOn, amountCents: line.amountCents, preferredAccountId: line.deposit?.accountId ?? null },
                  rows,
                ).map((row) => ({ ...row, daysApart: dayGap(row.occurredOn, view.occurredOn) })),
          })),
        };
      }),
    );
  } catch (error) {
    return failure(translatePairError(error), "Could not load deposit suggestions.", { action: "suggest-transfer-links", householdId: actor.householdId }, KNOWN);
  }
}

export type DepositChoice = CandidateRow & { linkedLineId: string | null };

/**
 * The split editor's "Existing deposit" choices for a paycheck on a date:
 * open deposits in other accounts inside the window (any amount; the editor
 * offers the ones that match each line), plus the deposits this split's
 * lines are already linked to.
 */
export async function depositChoices(actor: ServiceActor, transactionId: string): Promise<ServiceResult<DepositChoice[]>> {
  if (!UUID.test(transactionId)) return refuse(PAIR_NOT_HERE);
  try {
    return succeed(
      await withActor(actor.userId, async (tx) => {
        const [row] = await tx
          .select({ id: transaction.id, accountId: transaction.accountId, occurredOn: transaction.occurredOn, kind: transaction.splitKind })
          .from(transaction)
          .where(and(eq(transaction.id, transactionId), eq(transaction.householdId, actor.householdId)));
        if (!row) throw new SplitGroupError(PAIR_NOT_HERE);
        const open = await openDeposits(
          tx,
          actor.householdId,
          shiftCivilDate(row.occurredOn, -TRANSFER_PAIR_WINDOW_DAYS),
          shiftCivilDate(row.occurredOn, TRANSFER_PAIR_WINDOW_DAYS),
          null,
          row.accountId,
        );
        const view = row.kind ? (await loadSplitViews(tx, actor.householdId, [row.id])).get(row.id) : undefined;
        const linked: DepositChoice[] = (view?.lines ?? []).flatMap((line) =>
          line.linked
            ? [{ id: line.linked.id, accountId: line.linked.accountId, accountName: line.linked.accountName, occurredOn: line.linked.occurredOn, payee: line.linked.payee, amountCents: line.linked.amountCents, linkedLineId: line.id }]
            : [],
        );
        return [...linked, ...open.map((item) => ({ ...item, linkedLineId: null }))];
      }),
    );
  } catch (error) {
    return failure(translatePairError(error), "Could not load deposits.", { action: "deposit-choices", householdId: actor.householdId }, KNOWN);
  }
}
