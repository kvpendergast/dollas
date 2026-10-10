import {
  addDays,
  planRecurringLinks,
  type Cadence,
  type RecurringMatchItem,
  type RecurringMatchTransaction,
  type StatusItem,
} from "@dollas/domain";
import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { AppTx } from "@/db/client";
import { recurringDismissal, recurringItem, recurringLink, transaction } from "@/db/schema";

/**
 * Recurring item reads and the matching step (PEN-206). These run inside the
 * caller's withActor transaction, so household RLS applies and a link lands in
 * the same commit as the transaction, import, sync, or item that caused it.
 */

export type RecurringItemRow = typeof recurringItem.$inferSelect;

export function scheduleOf(row: RecurringItemRow): RecurringMatchItem & StatusItem {
  return {
    id: row.id,
    householdId: row.householdId,
    name: row.name,
    payeeMatch: row.payeeMatch,
    amountCents: row.amountCents,
    accountId: row.accountId,
    tolerancePercent: row.tolerancePercent,
    toleranceCents: row.toleranceCents,
    windowDays: row.windowDays,
    paused: row.pausedAt != null,
    cadence: row.cadence as Cadence,
    anchorDate: row.anchorDate,
    dayOfMonth: row.dayOfMonth,
    secondDayOfMonth: row.secondDayOfMonth,
    startDate: row.startDate,
    endDate: row.endDate,
  };
}

/** How far back a new or resumed item looks for transactions to link. */
export const BACKFILL_DAYS = 180;

export type RecurringMatchScope =
  /** Transactions just created, imported, synced, edited, or restored. */
  | { transactionIds: readonly string[] }
  /** A new, edited, or resumed item: link its recent history. */
  | { itemId: string; today: string };

/** Links matching transactions to recurring items. Returns how many links were added. */
export async function linkRecurringMatches(tx: AppTx, householdId: string, scope: RecurringMatchScope): Promise<number> {
  const itemRows = await tx
    .select()
    .from(recurringItem)
    .where(
      and(
        eq(recurringItem.householdId, householdId),
        isNull(recurringItem.pausedAt),
        "itemId" in scope ? eq(recurringItem.id, scope.itemId) : undefined,
      ),
    );
  if (itemRows.length === 0) return 0;
  const items = itemRows.map(scheduleOf);
  const maxWindow = Math.max(...items.map((item) => item.windowDays));

  const candidateColumns = {
    id: transaction.id,
    householdId: transaction.householdId,
    accountId: transaction.accountId,
    occurredOn: transaction.occurredOn,
    payee: transaction.payee,
    amountCents: transaction.amountCents,
    createdAt: transaction.createdAt,
  };
  let candidates: Array<{ id: string; householdId: string; accountId: string; occurredOn: string; payee: string; amountCents: number; createdAt: Date }>;
  if ("transactionIds" in scope) {
    if (scope.transactionIds.length === 0) return 0;
    candidates = await tx
      .select(candidateColumns)
      .from(transaction)
      .where(and(eq(transaction.householdId, householdId), inArray(transaction.id, [...scope.transactionIds]), isNull(transaction.deletedAt)));
  } else {
    const item = items[0];
    const from = addDays(scope.today, -BACKFILL_DAYS) > item.startDate ? addDays(scope.today, -BACKFILL_DAYS) : item.startDate;
    candidates = await tx
      .select(candidateColumns)
      .from(transaction)
      .leftJoin(recurringLink, eq(recurringLink.transactionId, transaction.id))
      .where(
        and(
          eq(transaction.householdId, householdId),
          isNull(transaction.deletedAt),
          isNull(recurringLink.id),
          gte(transaction.occurredOn, addDays(from, -item.windowDays)),
          lte(transaction.occurredOn, addDays(scope.today, item.windowDays)),
        ),
      );
  }
  if (candidates.length === 0) return 0;
  const dates = candidates.map((row) => row.occurredOn).sort();
  const low = addDays(dates[0], -maxWindow);
  const high = addDays(dates[dates.length - 1], maxWindow);
  const candidateIds = candidates.map((row) => row.id);
  const itemIds = items.map((item) => item.id);

  const links = await tx
    .select({
      id: recurringLink.id,
      itemId: recurringLink.recurringItemId,
      transactionId: recurringLink.transactionId,
      occurrenceDate: recurringLink.occurrenceDate,
      deletedAt: transaction.deletedAt,
    })
    .from(recurringLink)
    .innerJoin(transaction, eq(transaction.id, recurringLink.transactionId))
    .where(
      and(
        eq(recurringLink.householdId, householdId),
        or(
          and(inArray(recurringLink.recurringItemId, itemIds), gte(recurringLink.occurrenceDate, low), lte(recurringLink.occurrenceDate, high)),
          inArray(recurringLink.transactionId, candidateIds),
        ),
      ),
    );
  const dismissals = await tx
    .select({ itemId: recurringDismissal.recurringItemId, transactionId: recurringDismissal.transactionId })
    .from(recurringDismissal)
    .where(and(eq(recurringDismissal.householdId, householdId), inArray(recurringDismissal.transactionId, candidateIds)));

  const transactions: RecurringMatchTransaction[] = candidates.map((row) => ({
    ...row,
    deleted: false,
    createdAt: row.createdAt.toISOString(),
  }));
  const plan = planRecurringLinks({
    householdId,
    items,
    transactions,
    links: links.map((link) => ({ ...link, transactionDeleted: link.deletedAt != null })),
    dismissals,
  });
  if (plan.drop.length > 0) {
    await tx.delete(recurringLink).where(and(eq(recurringLink.householdId, householdId), inArray(recurringLink.id, plan.drop)));
  }
  if (plan.add.length === 0) return 0;
  const added = await tx
    .insert(recurringLink)
    .values(
      plan.add.map((link) => ({
        householdId,
        recurringItemId: link.itemId,
        transactionId: link.transactionId,
        occurrenceDate: link.occurrenceDate,
        source: "auto",
      })),
    )
    .onConflictDoNothing()
    .returning({ id: recurringLink.id });
  return added.length;
}

/** Links of these items in a date range, with each transaction's current state. */
export async function loadStatusLinks(tx: AppTx, householdId: string, itemIds: readonly string[], from?: string, to?: string) {
  if (itemIds.length === 0) return [];
  const rows = await tx
    .select({
      itemId: recurringLink.recurringItemId,
      occurrenceDate: recurringLink.occurrenceDate,
      transactionId: recurringLink.transactionId,
      source: recurringLink.source,
      occurredOn: transaction.occurredOn,
      payee: transaction.payee,
      amountCents: transaction.amountCents,
      deletedAt: transaction.deletedAt,
    })
    .from(recurringLink)
    .innerJoin(transaction, eq(transaction.id, recurringLink.transactionId))
    .where(
      and(
        eq(recurringLink.householdId, householdId),
        inArray(recurringLink.recurringItemId, [...itemIds]),
        from ? gte(recurringLink.occurrenceDate, from) : undefined,
        to ? lte(recurringLink.occurrenceDate, to) : undefined,
      ),
    )
    .orderBy(sql`${recurringLink.occurrenceDate} desc`);
  return rows.map(({ deletedAt, ...row }) => ({ ...row, deleted: deletedAt != null }));
}
