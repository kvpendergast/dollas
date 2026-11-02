import {
  SplitGroupError,
  accountAcceptsCorrection,
  accountAcceptsNewEntry,
  isIsoDate,
  NOTE_MAX_LENGTH,
  PAYEE_MAX_LENGTH,
  planSplit,
  type SplitCategoryKind,
  type SplitKind,
  type SplitLineDraft,
  type SplitPlan,
} from "@dollas/domain";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, like, lte, type SQL } from "drizzle-orm";
import { withActor } from "@/db/actor";
import type { AppTx } from "@/db/client";
import { category, ledgerAccount, transaction, transactionSplit } from "@/db/schema";
import { logInfo } from "@/lib/telemetry";
import { UUID, failure, refuse, succeed, type ServiceActor, type ServiceResult, type Via } from "@/lib/service-result";
import { loadSplitViews, type SplitView } from "./store";

/**
 * Split transactions (PEN-348). One bank or CSV row becomes a parent with child
 * transactions (lines). A paycheck parent (income) counts as gross income and
 * its negative lines are taxes (expense) and 401(k) / net pay (transfer); a net
 * pay line can deposit the same amount into a bank account. Any other parent
 * (allocation) leaves every total and its lines count instead. The database
 * re-checks every group at commit (assert_split_group_for).
 */

export const SPLIT_NOT_HERE = "That transaction is not in this household.";
export const SPLIT_ALREADY = "That transaction is already split. Use Edit split to change it.";
export const SPLIT_NOT_SPLIT = "That transaction is not split.";
export const SPLIT_RESTORE_FIRST = "Restore that transaction first.";
export const SPLIT_KEY_TAKEN = "That client key already belongs to another split.";
const CATEGORY_NOT_HERE = "Choose categories from this household.";
const ACCOUNT_NOT_HERE = "Choose a deposit account in this household.";
export const MAX_BULK_SPLITS = 50;
const KNOWN = [SPLIT_NOT_HERE, SPLIT_ALREADY, SPLIT_NOT_SPLIT, SPLIT_RESTORE_FIRST, SPLIT_KEY_TAKEN, CATEGORY_NOT_HERE, ACCOUNT_NOT_HERE];

export type SplitLineInput = {
  payee?: string | null;
  categoryId: string;
  /** Positive magnitude in cents; the sign follows the split. */
  amountCents?: number | null;
  remainderPercent?: number | null;
  toAccountId?: string | null;
  reimbursed?: boolean;
  note?: string | null;
};

export type CreateSplitInput = {
  transactionId: string;
  lines: readonly SplitLineInput[];
  clientKey?: string | null;
  /** Rows this split stands in for (e.g. a paycheck workaround). They are hidden and come back on Unsplit. */
  replacesTransactionIds?: readonly string[];
};

export type UpdateSplitInput = {
  transactionId: string;
  lines?: readonly SplitLineInput[];
  occurredOn?: string;
  payee?: string;
  note?: string | null;
  accountId?: string;
  amountCents?: number;
};

type ParentRow = {
  id: string;
  accountId: string;
  occurredOn: string;
  payee: string;
  amountCents: number;
  note: string | null;
  deletedAt: Date | null;
  splitKind: string | null;
  splitParentId: string | null;
  splitClientKey: string | null;
};

function textOf(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" ");
}

/** Database checks, in words a member can act on. */
function translate(error: unknown): unknown {
  const text = textOf(error);
  if (text.includes("transaction_split_client_key_idx")) return new SplitGroupError(SPLIT_KEY_TAKEN);
  if (text.includes("split lines must add up")) return new SplitGroupError("The lines must add up to the transaction.");
  if (text.includes("category splits must add up")) return new SplitGroupError("Each line needs one category for its full amount.");
  if (text.includes("a split stays in one household")) return new SplitGroupError(SPLIT_NOT_HERE);
  return error;
}

function differenceOf(error: unknown): number | null {
  return error instanceof SplitGroupError ? error.differenceCents : null;
}

/** The difference (cents still to assign, negative when over) on a refused split, or null. */
export function splitDifferenceOf(result: ServiceResult<unknown>): number | null {
  return result.ok ? null : differenceOf(result.error);
}

async function lockParent(tx: AppTx, householdId: string, transactionId: string): Promise<ParentRow> {
  if (!UUID.test(transactionId)) throw new SplitGroupError(SPLIT_NOT_HERE);
  const [row] = await tx
    .select({
      id: transaction.id,
      accountId: transaction.accountId,
      occurredOn: transaction.occurredOn,
      payee: transaction.payee,
      amountCents: transaction.amountCents,
      note: transaction.note,
      deletedAt: transaction.deletedAt,
      splitKind: transaction.splitKind,
      splitParentId: transaction.splitParentId,
      splitClientKey: transaction.splitClientKey,
    })
    .from(transaction)
    .where(and(eq(transaction.id, transactionId), eq(transaction.householdId, householdId)))
    .for("update");
  if (!row) throw new SplitGroupError(SPLIT_NOT_HERE);
  if (row.splitParentId) throw new SplitGroupError("That is a line of a split. Edit the split it belongs to.");
  return row;
}

async function parentCategories(tx: AppTx, householdId: string, transactionId: string) {
  return tx
    .select({ categoryId: transactionSplit.categoryId, amountCents: transactionSplit.amountCents, kind: category.kind })
    .from(transactionSplit)
    .innerJoin(category, eq(category.id, transactionSplit.categoryId))
    .where(and(eq(transactionSplit.householdId, householdId), eq(transactionSplit.transactionId, transactionId)));
}

async function draftsFor(tx: AppTx, householdId: string, lines: readonly SplitLineInput[]): Promise<SplitLineDraft[]> {
  const ids = [...new Set(lines.map((line) => line.categoryId).filter((id) => UUID.test(id)))];
  const known =
    ids.length === 0
      ? []
      : await tx
          .select({ id: category.id, kind: category.kind })
          .from(category)
          .where(and(eq(category.householdId, householdId), inArray(category.id, ids)));
  const kinds = new Map(known.map((row) => [row.id, row.kind as SplitCategoryKind]));
  return lines.map((line, index) => {
    const kind = kinds.get(line.categoryId);
    if (!kind) throw new SplitGroupError(line.categoryId ? CATEGORY_NOT_HERE : `Line ${index + 1} needs a category.`);
    return {
      payee: line.payee ?? null,
      categoryId: line.categoryId,
      categoryKind: kind,
      amountCents: line.amountCents ?? null,
      remainderPercent: line.remainderPercent ?? null,
      toAccountId: line.toAccountId ?? null,
      reimbursed: line.reimbursed === true,
      note: line.note ?? null,
    };
  });
}

async function requireDepositAccounts(tx: AppTx, householdId: string, plan: SplitPlan): Promise<void> {
  const ids = [...new Set(plan.lines.map((line) => line.toAccountId).filter((id): id is string => id != null))];
  if (ids.length === 0) return;
  if (ids.some((id) => !UUID.test(id))) throw new SplitGroupError(ACCOUNT_NOT_HERE);
  const rows = await tx
    .select({ id: ledgerAccount.id, householdId: ledgerAccount.householdId, archivedAt: ledgerAccount.archivedAt })
    .from(ledgerAccount)
    .where(and(eq(ledgerAccount.householdId, householdId), inArray(ledgerAccount.id, ids)));
  for (const id of ids) {
    const row = rows.find((item) => item.id === id);
    const accepted = accountAcceptsNewEntry(
      row ? { id: row.id, householdId: row.householdId, archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null } : null,
      householdId,
    );
    if (accepted.isErr()) throw new SplitGroupError(row ? accepted.error.message : ACCOUNT_NOT_HERE);
  }
}

async function planFor(tx: AppTx, householdId: string, parent: ParentRow, lines: readonly SplitLineInput[]): Promise<SplitPlan> {
  const categories = await parentCategories(tx, householdId, parent.id);
  const drafts = await draftsFor(tx, householdId, lines);
  const planned = planSplit(
    { amountCents: parent.amountCents, accountId: parent.accountId, payee: parent.payee, categoryKinds: categories.map((row) => row.kind as SplitCategoryKind) },
    drafts,
  );
  if (planned.isErr()) throw planned.error;
  await requireDepositAccounts(tx, householdId, planned.value);
  return planned.value;
}

/** Inserts the lines (each with one category line for its amount) and each line's deposit. */
async function writeLines(tx: AppTx, householdId: string, parent: ParentRow, plan: SplitPlan): Promise<void> {
  for (const line of plan.lines) {
    const [row] = await tx
      .insert(transaction)
      .values({
        householdId,
        accountId: parent.accountId,
        occurredOn: parent.occurredOn,
        payee: line.payee,
        amountCents: line.amountCents,
        note: line.note,
        splitParentId: parent.id,
        splitPosition: line.position,
        splitReimbursed: line.reimbursed,
      })
      .returning({ id: transaction.id });
    if (!row) throw new Error("split line insert returned no row");
    await tx.insert(transactionSplit).values({ transactionId: row.id, householdId, categoryId: line.categoryId, amountCents: line.amountCents });
    if (line.toAccountId) {
      const [deposit] = await tx
        .insert(transaction)
        .values({
          householdId,
          accountId: line.toAccountId,
          occurredOn: parent.occurredOn,
          payee: line.payee,
          amountCents: -line.amountCents,
          splitParentId: parent.id,
          splitLineId: row.id,
          splitPosition: line.position,
        })
        .returning({ id: transaction.id });
      if (!deposit) throw new Error("split deposit insert returned no row");
      await tx.insert(transactionSplit).values({ transactionId: deposit.id, householdId, categoryId: line.categoryId, amountCents: -line.amountCents });
    }
  }
}

async function clearLines(tx: AppTx, householdId: string, parentId: string): Promise<void> {
  await tx.delete(transaction).where(and(eq(transaction.householdId, householdId), eq(transaction.splitParentId, parentId)));
}

async function viewOf(tx: AppTx, householdId: string, parentId: string): Promise<SplitView> {
  const view = (await loadSplitViews(tx, householdId, [parentId])).get(parentId);
  if (!view) throw new SplitGroupError(SPLIT_NOT_SPLIT);
  return view;
}

function cleanKey(key: string | null | undefined): string | null {
  if (key == null) return null;
  const trimmed = key.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 100) throw new SplitGroupError("Keep the client key to 100 characters.");
  return trimmed;
}

async function replaceRows(tx: AppTx, householdId: string, parent: ParentRow, ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  if (unique.length > 50) throw new SplitGroupError("A split can stand in for at most 50 transactions.");
  if (unique.includes(parent.id)) throw new SplitGroupError("A split cannot replace its own transaction.");
  if (unique.some((id) => !UUID.test(id))) throw new SplitGroupError(SPLIT_NOT_HERE);
  const rows = await tx
    .select({
      id: transaction.id,
      deletedAt: transaction.deletedAt,
      splitKind: transaction.splitKind,
      splitParentId: transaction.splitParentId,
      splitReplacedBy: transaction.splitReplacedBy,
    })
    .from(transaction)
    .where(and(eq(transaction.householdId, householdId), inArray(transaction.id, unique)))
    .for("update");
  if (rows.length !== unique.length) throw new SplitGroupError(SPLIT_NOT_HERE);
  for (const row of rows) {
    if (row.deletedAt) throw new SplitGroupError("A transaction it replaces is already deleted.");
    if (row.splitKind || row.splitParentId || row.splitReplacedBy) throw new SplitGroupError("A transaction it replaces is already part of a split.");
  }
  await tx
    .update(transaction)
    .set({ deletedAt: new Date(), splitReplacedBy: parent.id })
    .where(and(eq(transaction.householdId, householdId), inArray(transaction.id, unique)));
}

async function createInTx(tx: AppTx, householdId: string, input: CreateSplitInput): Promise<{ status: "created" | "exists"; view: SplitView }> {
  const key = cleanKey(input.clientKey);
  if (key) {
    const [owner] = await tx
      .select({ id: transaction.id })
      .from(transaction)
      .where(and(eq(transaction.householdId, householdId), eq(transaction.splitClientKey, key)));
    if (owner) {
      if (owner.id !== input.transactionId) throw new SplitGroupError(SPLIT_KEY_TAKEN);
      return { status: "exists", view: await viewOf(tx, householdId, owner.id) };
    }
  }
  const parent = await lockParent(tx, householdId, input.transactionId);
  if (parent.deletedAt) throw new SplitGroupError(SPLIT_RESTORE_FIRST);
  if (parent.splitKind) throw new SplitGroupError(SPLIT_ALREADY);
  const plan = await planFor(tx, householdId, parent, input.lines);
  await tx
    .update(transaction)
    .set({ splitKind: plan.kind, splitClientKey: key })
    .where(and(eq(transaction.householdId, householdId), eq(transaction.id, parent.id)));
  await writeLines(tx, householdId, parent, plan);
  await replaceRows(tx, householdId, parent, input.replacesTransactionIds ?? []);
  return { status: "created", view: await viewOf(tx, householdId, parent.id) };
}

export async function createSplit(actor: ServiceActor, input: CreateSplitInput, via: Via = "web"): Promise<ServiceResult<SplitView & { status: "created" | "exists" }>> {
  try {
    const outcome = await withActor(actor.userId, (tx) => createInTx(tx, actor.householdId, input));
    if (outcome.status === "created") logInfo("Transaction split", { action: "create-split", via, householdId: actor.householdId, kind: outcome.view.kind });
    return succeed({ ...outcome.view, status: outcome.status });
  } catch (error) {
    return failure(translate(error), "Could not split that transaction.", { action: "create-split", via, householdId: actor.householdId }, KNOWN);
  }
}

export async function updateSplit(actor: ServiceActor, input: UpdateSplitInput, via: Via = "web"): Promise<ServiceResult<SplitView>> {
  if (input.occurredOn !== undefined && !isIsoDate(input.occurredOn)) return refuse("Use a date like 2026-01-31.");
  if (input.payee !== undefined && (input.payee.trim() === "" || input.payee.trim().length > PAYEE_MAX_LENGTH)) return refuse("Enter a payee.");
  if (input.note != null && input.note.trim().length > NOTE_MAX_LENGTH) return refuse("That note is too long.");
  if (input.amountCents !== undefined && (!Number.isSafeInteger(input.amountCents) || input.amountCents === 0)) return refuse("Enter an amount in whole cents.");
  try {
    const view = await withActor(actor.userId, async (tx) => {
      const before = await lockParent(tx, actor.householdId, input.transactionId);
      if (!before.splitKind) throw new SplitGroupError(SPLIT_NOT_SPLIT);
      if (before.deletedAt) throw new SplitGroupError(SPLIT_RESTORE_FIRST);
      const current = await viewOf(tx, actor.householdId, before.id);
      const categories = await parentCategories(tx, actor.householdId, before.id);
      if (input.accountId !== undefined && input.accountId !== before.accountId) {
        const [account] = UUID.test(input.accountId)
          ? await tx
              .select({ id: ledgerAccount.id, householdId: ledgerAccount.householdId, archivedAt: ledgerAccount.archivedAt })
              .from(ledgerAccount)
              .where(and(eq(ledgerAccount.id, input.accountId), eq(ledgerAccount.householdId, actor.householdId)))
          : [];
        const accepted = accountAcceptsCorrection(
          account ? { id: account.id, householdId: account.householdId, archivedAt: account.archivedAt ? account.archivedAt.toISOString() : null } : null,
          actor.householdId,
          before.accountId,
        );
        if (accepted.isErr()) throw accepted.error;
      }
      if (input.amountCents !== undefined && input.amountCents !== before.amountCents && categories.length !== 1) {
        throw new SplitGroupError("Change the amount of a transaction with one category only.");
      }
      const parent: ParentRow = {
        ...before,
        accountId: input.accountId ?? before.accountId,
        occurredOn: input.occurredOn ?? before.occurredOn,
        payee: input.payee?.trim() ?? before.payee,
        note: input.note === undefined ? before.note : input.note?.trim() || null,
        amountCents: input.amountCents ?? before.amountCents,
      };
      const lines: readonly SplitLineInput[] =
        input.lines ??
        current.lines.map((line) => ({
          payee: line.payee,
          categoryId: line.categoryId ?? "",
          amountCents: Math.abs(line.amountCents),
          toAccountId: line.deposit?.accountId ?? null,
          reimbursed: line.reimbursed,
          note: line.note,
        }));
      await tx
        .update(transaction)
        .set({ accountId: parent.accountId, occurredOn: parent.occurredOn, payee: parent.payee, note: parent.note, amountCents: parent.amountCents })
        .where(and(eq(transaction.householdId, actor.householdId), eq(transaction.id, parent.id)));
      if (parent.amountCents !== before.amountCents) {
        await tx
          .update(transactionSplit)
          .set({ amountCents: parent.amountCents })
          .where(and(eq(transactionSplit.householdId, actor.householdId), eq(transactionSplit.transactionId, parent.id)));
      }
      const plan = await planFor(tx, actor.householdId, parent, lines);
      await clearLines(tx, actor.householdId, parent.id);
      await tx
        .update(transaction)
        .set({ splitKind: plan.kind })
        .where(and(eq(transaction.householdId, actor.householdId), eq(transaction.id, parent.id)));
      await writeLines(tx, actor.householdId, parent, plan);
      return viewOf(tx, actor.householdId, parent.id);
    });
    logInfo("Split edited", { action: "update-split", via, householdId: actor.householdId, kind: view.kind });
    return succeed(view);
  } catch (error) {
    return failure(translate(error), "Could not save that split.", { action: "update-split", via, householdId: actor.householdId, transactionId: input.transactionId }, KNOWN);
  }
}

/** Removes the lines and deposits, keeps the original transaction, and brings back rows the split replaced. */
export async function unsplitTransaction(
  actor: ServiceActor,
  transactionId: string,
  via: Via = "web",
): Promise<ServiceResult<{ id: string; payee: string; removedLines: number; restored: number }>> {
  try {
    const outcome = await withActor(actor.userId, async (tx) => {
      const parent = await lockParent(tx, actor.householdId, transactionId);
      if (!parent.splitKind) throw new SplitGroupError(SPLIT_NOT_SPLIT);
      if (parent.deletedAt) throw new SplitGroupError(SPLIT_RESTORE_FIRST);
      const removed = await tx
        .delete(transaction)
        .where(and(eq(transaction.householdId, actor.householdId), eq(transaction.splitParentId, parent.id), isNull(transaction.splitLineId)))
        .returning({ id: transaction.id });
      await clearLines(tx, actor.householdId, parent.id);
      await tx
        .update(transaction)
        .set({ splitKind: null, splitClientKey: null })
        .where(and(eq(transaction.householdId, actor.householdId), eq(transaction.id, parent.id)));
      const restored = await tx
        .update(transaction)
        .set({ deletedAt: null, splitReplacedBy: null })
        .where(and(eq(transaction.householdId, actor.householdId), eq(transaction.splitReplacedBy, parent.id)))
        .returning({ id: transaction.id });
      return { id: parent.id, payee: parent.payee, removedLines: removed.length, restored: restored.length };
    });
    logInfo("Split removed", { action: "unsplit-transaction", via, householdId: actor.householdId });
    return succeed(outcome);
  } catch (error) {
    return failure(translate(error), "Could not unsplit that transaction.", { action: "unsplit-transaction", via, householdId: actor.householdId, transactionId }, KNOWN);
  }
}

export async function getSplit(actor: ServiceActor, transactionId: string): Promise<ServiceResult<SplitView>> {
  if (!UUID.test(transactionId)) return refuse(SPLIT_NOT_HERE);
  try {
    return succeed(await withActor(actor.userId, (tx) => viewOf(tx, actor.householdId, transactionId)));
  } catch (error) {
    return failure(error, "Could not load that split.", { action: "get-split", householdId: actor.householdId }, KNOWN);
  }
}

export type SplitListFilter = { from?: string; to?: string; kind?: SplitKind; clientKeyPrefix?: string; limit: number; offset: number };

export async function listSplits(actor: ServiceActor, filter: SplitListFilter): Promise<ServiceResult<{ items: SplitView[]; total: number }>> {
  if (filter.from && !isIsoDate(filter.from)) return refuse("Use a from date like 2026-01-01.");
  if (filter.to && !isIsoDate(filter.to)) return refuse("Use a to date like 2026-01-31.");
  try {
    return succeed(
      await withActor(actor.userId, async (tx) => {
        const where: SQL[] = [eq(transaction.householdId, actor.householdId), isNull(transaction.deletedAt), isNotNull(transaction.splitKind)];
        if (filter.kind) where.push(eq(transaction.splitKind, filter.kind));
        if (filter.from) where.push(gte(transaction.occurredOn, filter.from));
        if (filter.to) where.push(lte(transaction.occurredOn, filter.to));
        if (filter.clientKeyPrefix) {
          const prefix = filter.clientKeyPrefix.replace(/[\\%_]/g, (c) => `\\${c}`);
          where.push(sqlLike(prefix));
        }
        const matching = and(...where);
        const [counted] = await tx.select({ value: count() }).from(transaction).where(matching);
        const rows = await tx
          .select({ id: transaction.id })
          .from(transaction)
          .where(matching)
          .orderBy(desc(transaction.occurredOn), asc(transaction.id))
          .limit(filter.limit)
          .offset(filter.offset);
        const views = await loadSplitViews(tx, actor.householdId, rows.map((row) => row.id));
        return { total: Number(counted?.value ?? 0), items: rows.map((row) => views.get(row.id)).filter((view): view is SplitView => view != null) };
      }),
    );
  } catch (error) {
    return failure(error, "Could not load splits.", { action: "list-splits", householdId: actor.householdId });
  }
}

function sqlLike(prefix: string): SQL {
  return like(transaction.splitClientKey, `${prefix}%`);
}

export type BulkSplitItem = CreateSplitInput & { clientKey: string };
export type BulkSplitResult = {
  clientKey: string;
  transactionId: string;
  status: "created" | "exists" | "error" | "rolled_back";
  message?: string;
  differenceCents?: number | null;
  split?: SplitView;
};

/**
 * Many splits at once, each keyed by the caller's client key so a retry never
 * splits twice. per_item: each item commits or fails alone. atomic: all or none.
 */
export async function createSplits(
  actor: ServiceActor,
  items: readonly BulkSplitItem[],
  mode: "per_item" | "atomic" = "per_item",
  via: Via = "web",
): Promise<ServiceResult<{ results: BulkSplitResult[]; created: number; existing: number; failed: number }>> {
  if (items.length === 0) return refuse("Send at least one split.");
  if (items.length > MAX_BULK_SPLITS) return refuse(`Send up to ${MAX_BULK_SPLITS} splits at a time.`);
  const keys = items.map((item) => item.clientKey?.trim() ?? "");
  if (keys.some((key) => key === "")) return refuse("Give every split a client key.");
  if (new Set(keys).size !== keys.length) return refuse("Use each client key once.");
  const results: BulkSplitResult[] = [];
  if (mode === "atomic") {
    let failedAt = -1;
    let failedError: unknown = null;
    try {
      const done = await withActor(actor.userId, async (tx) => {
        const out: { status: "created" | "exists"; view: SplitView }[] = [];
        for (const [index, item] of items.entries()) {
          try {
            out.push(await createInTx(tx, actor.householdId, item));
          } catch (error) {
            failedAt = index;
            throw error;
          }
        }
        return out;
      });
      for (const [index, item] of items.entries()) {
        const outcome = done[index];
        if (outcome) results.push({ clientKey: keys[index] ?? "", transactionId: item.transactionId, status: outcome.status, split: outcome.view });
      }
    } catch (error) {
      failedError = error;
      const result = failure(translate(error), "Could not split that transaction.", { action: "create-splits", via, householdId: actor.householdId }, KNOWN);
      for (const [index, item] of items.entries()) {
        const failedHere = index === failedAt || (failedAt === -1 && index === items.length - 1);
        results.push({
          clientKey: keys[index] ?? "",
          transactionId: item.transactionId,
          status: failedHere ? "error" : "rolled_back",
          ...(failedHere && !result.ok ? { message: result.memberMessage, differenceCents: differenceOf(translate(failedError)) } : {}),
        });
      }
    }
  } else {
    for (const [index, item] of items.entries()) {
      const result = await createSplit(actor, { ...item, clientKey: keys[index] }, via);
      if (result.ok) {
        const { status, ...view } = result.value;
        results.push({ clientKey: keys[index] ?? "", transactionId: item.transactionId, status, split: view });
      } else {
        results.push({ clientKey: keys[index] ?? "", transactionId: item.transactionId, status: "error", message: result.memberMessage, differenceCents: splitDifferenceOf(result) });
      }
    }
  }
  const created = results.filter((row) => row.status === "created").length;
  const existing = results.filter((row) => row.status === "exists").length;
  const failed = results.filter((row) => row.status === "error").length;
  logInfo("Splits created in bulk", { action: "create-splits", via, householdId: actor.householdId, created: String(created), failed: String(failed), mode });
  return succeed({ results, created, existing, failed });
}
