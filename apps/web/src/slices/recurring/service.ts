import {
  CADENCE_LABELS,
  addDays,
  defineRecurringItem,
  expectedRecurringAmounts,
  itemOccurrences,
  nextExpectedDate,
  nextOccurrences,
  occurrenceForManualLink,
  suggestRecurringItems,
  type Cadence,
  type ExpectedRecurring,
  type OccurrenceStatus,
  type RecurringItemDefinition,
  type RecurringItemInput,
  type RecurringOccurrence,
  type RecurringSuggestion,
} from "@dollas/domain";
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import { withActor } from "@/db/actor";
import type { AppTx } from "@/db/client";
import { category, categoryGroup, ledgerAccount, recurringDismissal, recurringItem, recurringLink, transaction, transactionSplit } from "@/db/schema";
import { logInfo } from "@/lib/telemetry";
import { UUID, failure, refuse, succeed, type ServiceActor, type ServiceResult, type Via } from "@/lib/service-result";
import { linkRecurringMatches, loadStatusLinks, scheduleOf, type RecurringItemRow } from "./store";

/**
 * Recurring item services (PEN-206), shared by the Recurring page, Activity,
 * and MCP tools. `today` is the household's civil date (books.asOf); statuses
 * and backfill depend on it, so callers pass it rather than the server clock.
 */

const NOT_HERE = "That recurring item is not in this household.";
const TXN_NOT_HERE = "That transaction is not in this household.";
const NOT_LINKED = "That transaction is not linked to a recurring item.";
const CATEGORY = "Choose a category from this household.";
const ACCOUNT = "Choose an account from this household.";
const KNOWN = [NOT_HERE, TXN_NOT_HERE, NOT_LINKED, CATEGORY, ACCOUNT];

export type MonthStatus = OccurrenceStatus | "none" | "paused";

export type RecurringItemSummary = {
  id: string;
  name: string;
  payeeMatch: string;
  amountCents: number;
  kind: "bill" | "income";
  cadence: Cadence;
  cadenceLabel: string;
  anchorDate: string;
  dayOfMonth: number | null;
  secondDayOfMonth: number | null;
  categoryId: string | null;
  categoryName: string | null;
  accountId: string | null;
  accountName: string | null;
  tolerancePercent: number;
  toleranceCents: number;
  windowDays: number;
  startDate: string;
  endDate: string | null;
  paused: boolean;
  nextDate: string | null;
  /** The worst status among this month's occurrences: missed, then expected, upcoming, then paid/received. */
  monthStatus: MonthStatus;
  thisMonth: RecurringOccurrence[];
};

export type RecurringItemDetail = RecurringItemSummary & {
  occurrences: RecurringOccurrence[];
  history: Array<{ transactionId: string; occurrenceDate: string; occurredOn: string; payee: string; amountCents: number; source: string }>;
};

function monthBounds(today: string): { from: string; to: string } {
  const from = `${today.slice(0, 8)}01`;
  const [y, m] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from, to: `${today.slice(0, 8)}${String(last).padStart(2, "0")}` };
}

const STATUS_RANK: Record<OccurrenceStatus, number> = { missed: 0, expected: 1, upcoming: 2, paid: 3, received: 3 };

function monthStatusOf(occurrences: readonly RecurringOccurrence[], paused: boolean): MonthStatus {
  if (occurrences.length === 0) return paused ? "paused" : "none";
  return [...occurrences].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])[0].status;
}

async function loadItems(tx: AppTx, householdId: string, itemId?: string) {
  return tx
    .select({ item: recurringItem, categoryName: category.name, groupName: categoryGroup.name, accountName: ledgerAccount.name })
    .from(recurringItem)
    .leftJoin(category, eq(category.id, recurringItem.categoryId))
    .leftJoin(categoryGroup, eq(categoryGroup.id, category.groupId))
    .leftJoin(ledgerAccount, eq(ledgerAccount.id, recurringItem.accountId))
    .where(and(eq(recurringItem.householdId, householdId), itemId ? eq(recurringItem.id, itemId) : undefined));
}

type LoadedItem = Awaited<ReturnType<typeof loadItems>>[number];

function summarize(row: LoadedItem, links: Awaited<ReturnType<typeof loadStatusLinks>>, today: string): RecurringItemSummary {
  const item = row.item;
  const schedule = scheduleOf(item);
  const month = monthBounds(today);
  const mine = links.filter((link) => link.itemId === item.id);
  const thisMonth = itemOccurrences(schedule, mine, month.from, month.to, today);
  return {
    id: item.id,
    name: item.name,
    payeeMatch: item.payeeMatch,
    amountCents: item.amountCents,
    kind: item.amountCents > 0 ? "income" : "bill",
    cadence: schedule.cadence,
    cadenceLabel: CADENCE_LABELS[schedule.cadence],
    anchorDate: item.anchorDate,
    dayOfMonth: item.dayOfMonth,
    secondDayOfMonth: item.secondDayOfMonth,
    categoryId: item.categoryId,
    categoryName: row.categoryName ? (row.groupName ? `${row.groupName} · ${row.categoryName}` : row.categoryName) : null,
    accountId: item.accountId,
    accountName: row.accountName,
    tolerancePercent: item.tolerancePercent,
    toleranceCents: item.toleranceCents,
    windowDays: item.windowDays,
    startDate: item.startDate,
    endDate: item.endDate,
    paused: schedule.paused,
    nextDate: nextExpectedDate(schedule, mine, today),
    monthStatus: monthStatusOf(thisMonth, schedule.paused),
    thisMonth,
  };
}

/** Every item with its next date and this month's status. Bills and income, by next date then name. */
export async function listRecurringItems(actor: ServiceActor, today: string): Promise<ServiceResult<RecurringItemSummary[]>> {
  try {
    const items = await withActor(actor.userId, async (tx) => {
      const rows = await loadItems(tx, actor.householdId);
      const links = await loadStatusLinks(tx, actor.householdId, rows.map((row) => row.item.id), addDays(today, -400), addDays(today, 400));
      return rows.map((row) => summarize(row, links, today));
    });
    items.sort((a, b) => {
      if (a.paused !== b.paused) return a.paused ? 1 : -1;
      return (a.nextDate ?? "9999").localeCompare(b.nextDate ?? "9999") || a.name.localeCompare(b.name);
    });
    return succeed(items);
  } catch (error) {
    return failure(error, "Could not load recurring items.", { action: "list-recurring", householdId: actor.householdId });
  }
}

/** One item, its occurrences (the last three months and the next few), and its linked history. */
export async function getRecurringItem(actor: ServiceActor, itemId: string, today: string): Promise<ServiceResult<RecurringItemDetail>> {
  if (!UUID.test(itemId)) return refuse(NOT_HERE);
  try {
    const detail = await withActor(actor.userId, async (tx) => {
      const [row] = await loadItems(tx, actor.householdId, itemId);
      if (!row) throw new Error(NOT_HERE);
      const links = await loadStatusLinks(tx, actor.householdId, [itemId]);
      const schedule = scheduleOf(row.item);
      const ahead = nextOccurrences(schedule, today, 3);
      const to = [addDays(today, 62), ahead[ahead.length - 1] ?? today].sort()[1];
      const occurrences = itemOccurrences(schedule, links, addDays(today, -92), to, today);
      return {
        ...summarize(row, links, today),
        occurrences,
        history: links
          .filter((link) => !link.deleted)
          .slice(0, 50)
          .map((link) => ({
            transactionId: link.transactionId,
            occurrenceDate: link.occurrenceDate,
            occurredOn: link.occurredOn,
            payee: link.payee,
            amountCents: link.amountCents,
            source: link.source,
          })),
      };
    });
    return succeed(detail);
  } catch (error) {
    return failure(error, "Could not load that recurring item.", { action: "get-recurring", householdId: actor.householdId }, KNOWN);
  }
}

async function requireTargets(tx: AppTx, householdId: string, defined: RecurringItemDefinition): Promise<void> {
  if (defined.categoryId) {
    if (!UUID.test(defined.categoryId)) throw new Error(CATEGORY);
    const [row] = await tx
      .select({ id: category.id })
      .from(category)
      .where(and(eq(category.id, defined.categoryId), eq(category.householdId, householdId)));
    if (!row) throw new Error(CATEGORY);
  }
  if (defined.accountId) {
    if (!UUID.test(defined.accountId)) throw new Error(ACCOUNT);
    const [row] = await tx
      .select({ id: ledgerAccount.id })
      .from(ledgerAccount)
      .where(and(eq(ledgerAccount.id, defined.accountId), eq(ledgerAccount.householdId, householdId)));
    if (!row) throw new Error(ACCOUNT);
  }
}

function columns(defined: RecurringItemDefinition) {
  return {
    name: defined.name,
    payeeMatch: defined.payeeMatch,
    amountCents: defined.amountCents,
    cadence: defined.cadence,
    anchorDate: defined.anchorDate,
    dayOfMonth: defined.dayOfMonth,
    secondDayOfMonth: defined.secondDayOfMonth,
    categoryId: defined.categoryId,
    accountId: defined.accountId,
    tolerancePercent: defined.tolerancePercent,
    toleranceCents: defined.toleranceCents,
    windowDays: defined.windowDays,
    startDate: defined.startDate,
    endDate: defined.endDate,
  };
}

export type SavedRecurringItem = { id: string; name: string; linked: number };

/** Adds an item and links matching transactions from the last 180 days. */
export async function createRecurringItem(
  actor: ServiceActor,
  input: RecurringItemInput,
  today: string,
  via: Via = "web",
): Promise<ServiceResult<SavedRecurringItem>> {
  const defined = defineRecurringItem(input);
  if (defined.isErr()) return refuse(defined.error.message, defined.error);
  try {
    const saved = await withActor(actor.userId, async (tx) => {
      await requireTargets(tx, actor.householdId, defined.value);
      const [row] = await tx
        .insert(recurringItem)
        .values({ householdId: actor.householdId, ...columns(defined.value) })
        .returning({ id: recurringItem.id });
      if (!row) throw new Error("recurring item insert returned no row");
      const linked = await linkRecurringMatches(tx, actor.householdId, { itemId: row.id, today });
      return { id: row.id, name: defined.value.name, linked };
    });
    logInfo("Recurring item added", { action: "create-recurring", via, householdId: actor.householdId });
    return succeed(saved);
  } catch (error) {
    return failure(error, "Could not add that recurring item.", { action: "create-recurring", via, householdId: actor.householdId }, KNOWN);
  }
}

function inputOf(row: RecurringItemRow): RecurringItemInput {
  return {
    name: row.name,
    payeeMatch: row.payeeMatch,
    amountCents: row.amountCents,
    cadence: row.cadence,
    anchorDate: row.anchorDate,
    dayOfMonth: row.dayOfMonth,
    secondDayOfMonth: row.secondDayOfMonth,
    categoryId: row.categoryId,
    accountId: row.accountId,
    tolerancePercent: row.tolerancePercent,
    toleranceCents: row.toleranceCents,
    windowDays: row.windowDays,
    startDate: row.startDate,
    endDate: row.endDate,
  };
}

/**
 * Edits an item. Fields left out stay as they are (a tool's partial patch);
 * the form sends everything. Links already made stay; new matches are added.
 */
export async function updateRecurringItem(
  actor: ServiceActor,
  itemId: string,
  patch: Partial<RecurringItemInput>,
  today: string,
  via: Via = "web",
): Promise<ServiceResult<SavedRecurringItem>> {
  if (!UUID.test(itemId)) return refuse(NOT_HERE);
  try {
    const saved = await withActor(actor.userId, async (tx) => {
      const [current] = await tx
        .select()
        .from(recurringItem)
        .where(and(eq(recurringItem.id, itemId), eq(recurringItem.householdId, actor.householdId)))
        .for("update");
      if (!current) throw new Error(NOT_HERE);
      const merged = { ...inputOf(current) };
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
      }
      const defined = defineRecurringItem(merged);
      if (defined.isErr()) throw defined.error;
      await requireTargets(tx, actor.householdId, defined.value);
      await tx
        .update(recurringItem)
        .set({ ...columns(defined.value), updatedAt: new Date() })
        .where(and(eq(recurringItem.id, itemId), eq(recurringItem.householdId, actor.householdId)));
      const linked = await linkRecurringMatches(tx, actor.householdId, { itemId, today });
      return { id: itemId, name: defined.value.name, linked };
    });
    logInfo("Recurring item edited", { action: "update-recurring", via, householdId: actor.householdId });
    return succeed(saved);
  } catch (error) {
    return failure(error, "Could not save that recurring item.", { action: "update-recurring", via, householdId: actor.householdId }, KNOWN);
  }
}

/** Pause stops matching and expecting; resume picks both up again and links recent history. */
export async function setRecurringItemPaused(
  actor: ServiceActor,
  itemId: string,
  paused: boolean,
  today: string,
  via: Via = "web",
): Promise<ServiceResult<SavedRecurringItem & { paused: boolean }>> {
  if (!UUID.test(itemId)) return refuse(NOT_HERE);
  const action = paused ? "pause-recurring" : "resume-recurring";
  try {
    const saved = await withActor(actor.userId, async (tx) => {
      const [row] = await tx
        .update(recurringItem)
        .set({ pausedAt: paused ? new Date() : null, updatedAt: new Date() })
        .where(and(eq(recurringItem.id, itemId), eq(recurringItem.householdId, actor.householdId)))
        .returning({ id: recurringItem.id, name: recurringItem.name });
      if (!row) throw new Error(NOT_HERE);
      const linked = paused ? 0 : await linkRecurringMatches(tx, actor.householdId, { itemId, today });
      return { id: row.id, name: row.name, linked, paused };
    });
    logInfo(paused ? "Recurring item paused" : "Recurring item resumed", { action, via, householdId: actor.householdId });
    return succeed(saved);
  } catch (error) {
    return failure(error, "Could not change that recurring item.", { action, via, householdId: actor.householdId }, KNOWN);
  }
}

/** Deletes an item and its links. The transactions stay, standing alone again. */
export async function deleteRecurringItem(
  actor: ServiceActor,
  itemId: string,
  via: Via = "web",
): Promise<ServiceResult<{ id: string; name: string; unlinked: number }>> {
  if (!UUID.test(itemId)) return refuse(NOT_HERE);
  try {
    const removed = await withActor(actor.userId, async (tx) => {
      const links = await tx
        .select({ id: recurringLink.id })
        .from(recurringLink)
        .where(and(eq(recurringLink.recurringItemId, itemId), eq(recurringLink.householdId, actor.householdId)));
      const [row] = await tx
        .delete(recurringItem)
        .where(and(eq(recurringItem.id, itemId), eq(recurringItem.householdId, actor.householdId)))
        .returning({ id: recurringItem.id, name: recurringItem.name });
      if (!row) throw new Error(NOT_HERE);
      return { ...row, unlinked: links.length };
    });
    logInfo("Recurring item deleted", { action: "delete-recurring", via, householdId: actor.householdId });
    return succeed(removed);
  } catch (error) {
    return failure(error, "Could not delete that recurring item.", { action: "delete-recurring", via, householdId: actor.householdId }, KNOWN);
  }
}

/**
 * A member links a transaction by hand. Payee and amount are the member's
 * call; the transaction takes the item's nearest open occurrence and leaves
 * any other item it was linked to. Clears an earlier unlink of this pair.
 */
export async function linkRecurringTransaction(
  actor: ServiceActor,
  itemId: string,
  transactionId: string,
  via: Via = "web",
): Promise<ServiceResult<{ itemId: string; name: string; transactionId: string; occurrenceDate: string }>> {
  if (!UUID.test(itemId)) return refuse(NOT_HERE);
  if (!UUID.test(transactionId)) return refuse(TXN_NOT_HERE);
  try {
    const linked = await withActor(actor.userId, async (tx) => {
      const [item] = await tx
        .select()
        .from(recurringItem)
        .where(and(eq(recurringItem.id, itemId), eq(recurringItem.householdId, actor.householdId)))
        .for("update");
      if (!item) throw new Error(NOT_HERE);
      const [txn] = await tx
        .select({ id: transaction.id, occurredOn: transaction.occurredOn })
        .from(transaction)
        .where(and(eq(transaction.id, transactionId), eq(transaction.householdId, actor.householdId), isNull(transaction.deletedAt)))
        .for("update");
      if (!txn) throw new Error(TXN_NOT_HERE);
      await tx.delete(recurringLink).where(and(eq(recurringLink.transactionId, transactionId), eq(recurringLink.householdId, actor.householdId)));
      const links = await loadStatusLinks(tx, actor.householdId, [itemId]);
      const filled = new Set(links.filter((link) => !link.deleted).map((link) => link.occurrenceDate));
      const occurrence = occurrenceForManualLink(scheduleOf(item), txn.occurredOn, filled);
      if (occurrence.isErr()) throw occurrence.error;
      // A link held by a soft-deleted transaction gives the occurrence up.
      await tx
        .delete(recurringLink)
        .where(
          and(
            eq(recurringLink.householdId, actor.householdId),
            eq(recurringLink.recurringItemId, itemId),
            eq(recurringLink.occurrenceDate, occurrence.value),
          ),
        );
      await tx
        .delete(recurringDismissal)
        .where(and(eq(recurringDismissal.recurringItemId, itemId), eq(recurringDismissal.transactionId, transactionId)));
      await tx.insert(recurringLink).values({
        householdId: actor.householdId,
        recurringItemId: itemId,
        transactionId,
        occurrenceDate: occurrence.value,
        source: "manual",
      });
      return { itemId, name: item.name, transactionId, occurrenceDate: occurrence.value };
    });
    logInfo("Recurring transaction linked", { action: "link-recurring", via, householdId: actor.householdId });
    return succeed(linked);
  } catch (error) {
    return failure(error, "Could not link that transaction.", { action: "link-recurring", via, householdId: actor.householdId }, KNOWN);
  }
}

/** Unlinks a transaction from its item. The pair is remembered, so matching never relinks it. */
export async function unlinkRecurringTransaction(
  actor: ServiceActor,
  transactionId: string,
  via: Via = "web",
): Promise<ServiceResult<{ itemId: string; name: string; transactionId: string }>> {
  if (!UUID.test(transactionId)) return refuse(TXN_NOT_HERE);
  try {
    const unlinked = await withActor(actor.userId, async (tx) => {
      const [link] = await tx
        .delete(recurringLink)
        .where(and(eq(recurringLink.transactionId, transactionId), eq(recurringLink.householdId, actor.householdId)))
        .returning({ itemId: recurringLink.recurringItemId });
      if (!link) throw new Error(NOT_LINKED);
      await tx
        .insert(recurringDismissal)
        .values({ householdId: actor.householdId, recurringItemId: link.itemId, transactionId })
        .onConflictDoNothing();
      const [item] = await tx.select({ name: recurringItem.name }).from(recurringItem).where(eq(recurringItem.id, link.itemId));
      return { itemId: link.itemId, name: item?.name ?? "", transactionId };
    });
    logInfo("Recurring transaction unlinked", { action: "unlink-recurring", via, householdId: actor.householdId });
    return succeed(unlinked);
  } catch (error) {
    return failure(error, "Could not unlink that transaction.", { action: "unlink-recurring", via, householdId: actor.householdId }, KNOWN);
  }
}

/** Payees in the last 200 days that look like a bill or paycheck and have no item yet. */
export async function suggestRecurring(actor: ServiceActor, today: string): Promise<ServiceResult<RecurringSuggestion[]>> {
  try {
    const suggestions = await withActor(actor.userId, async (tx) => {
      const rows = await tx
        .select({
          id: transaction.id,
          payee: transaction.payee,
          amountCents: transaction.amountCents,
          occurredOn: transaction.occurredOn,
          accountId: transaction.accountId,
        })
        .from(transaction)
        .where(and(eq(transaction.householdId, actor.householdId), isNull(transaction.deletedAt), gte(transaction.occurredOn, addDays(today, -200))))
        .orderBy(desc(transaction.occurredOn))
        .limit(5000);
      const splits =
        rows.length === 0
          ? []
          : await tx
              .select({ transactionId: transactionSplit.transactionId, categoryId: transactionSplit.categoryId })
              .from(transactionSplit)
              .where(and(eq(transactionSplit.householdId, actor.householdId), inArray(transactionSplit.transactionId, rows.map((row) => row.id))));
      const categoryOf = new Map(splits.map((split) => [split.transactionId, split.categoryId] as const));
      const items = await tx.select({ payeeMatch: recurringItem.payeeMatch }).from(recurringItem).where(eq(recurringItem.householdId, actor.householdId));
      return suggestRecurringItems({
        today,
        existingPayeeMatches: items.map((item) => item.payeeMatch),
        transactions: rows.map((row) => ({ ...row, categoryId: categoryOf.get(row.id) ?? null, deleted: false })),
      }).slice(0, 10);
    });
    return succeed(suggestions);
  } catch (error) {
    return failure(error, "Could not look for recurring payees.", { action: "suggest-recurring", householdId: actor.householdId });
  }
}

/**
 * Expected recurring amounts from `from` to `to`, split into already paid
 * (linked transactions) and still expected (PEN-205's projection reads this).
 */
export async function loadExpectedRecurring(
  actor: ServiceActor,
  range: { from: string; to: string },
  today: string,
): Promise<ServiceResult<ExpectedRecurring>> {
  try {
    const expected = await withActor(actor.userId, async (tx) => {
      const rows = await tx.select().from(recurringItem).where(eq(recurringItem.householdId, actor.householdId));
      const links = await loadStatusLinks(tx, actor.householdId, rows.map((row) => row.id), range.from, range.to);
      return expectedRecurringAmounts({ items: rows.map(scheduleOf), links, from: range.from, to: range.to, today });
    });
    return succeed(expected);
  } catch (error) {
    return failure(error, "Could not load recurring amounts.", { action: "expected-recurring", householdId: actor.householdId });
  }
}

