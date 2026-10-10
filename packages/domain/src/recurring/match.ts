import { err, ok, type Result } from "neverthrow";
import { RecurringError } from "../errors";
import type { Cents } from "../money/cents";
import { payeeRuleKey } from "../rules/payee-category";
import { addDays, cadencePeriodDays, daysBetween, occurrencesBetween, type RecurringSchedule } from "./schedule";

/**
 * Linking transactions to recurring items (PEN-206).
 *
 * A transaction matches an occurrence of an item when all hold:
 * - same household; if the item names an account, the same account;
 * - the payee contains the item's payee match, ignoring case and surrounding
 *   spaces (the payee-rule normalization, `payeeRuleKey`);
 * - the same sign, and the amount is within tolerance: the larger of
 *   `tolerancePercent` of the expected amount and `toleranceCents`;
 * - the date is within `windowDays` of the expected date.
 * The transaction must be live (not soft-deleted), not already linked to any
 * item, and not unlinked from this item by a member (a dismissal sticks).
 * Each occurrence takes at most one transaction and each transaction at most
 * one occurrence. Pairs are claimed best-first: closest date, then closest
 * amount, then item id, then the oldest transaction. Paused items do not match.
 * An occurrence held only by a soft-deleted transaction is free again; the
 * stale link is dropped when a live transaction takes it.
 */
export type RecurringMatchItem = RecurringSchedule & {
  id: string;
  householdId: string;
  payeeMatch: string;
  amountCents: Cents;
  accountId: string | null;
  tolerancePercent: number;
  toleranceCents: number;
  windowDays: number;
  paused: boolean;
};

export type RecurringMatchTransaction = {
  id: string;
  householdId: string;
  accountId: string;
  occurredOn: string;
  payee: string;
  amountCents: Cents;
  deleted: boolean;
  createdAt: string;
};

export type RecurringLinkRow = {
  id: string;
  itemId: string;
  transactionId: string;
  occurrenceDate: string;
  transactionDeleted: boolean;
};

export type RecurringDismissal = { itemId: string; transactionId: string };

export type PlannedRecurringLink = { itemId: string; transactionId: string; occurrenceDate: string };

export type RecurringLinkPlan = { add: PlannedRecurringLink[]; drop: string[] };

export function payeeMatchesItem(payee: string, payeeMatch: string): boolean {
  const needle = payeeRuleKey(payeeMatch);
  return needle.length > 0 && payee.toLowerCase().includes(needle);
}

/** The largest difference from the expected amount that still matches, in cents. */
export function amountTolerance(item: Pick<RecurringMatchItem, "amountCents" | "tolerancePercent" | "toleranceCents">): number {
  return Math.max(Math.round((Math.abs(item.amountCents) * item.tolerancePercent) / 100), item.toleranceCents);
}

export function amountMatchesItem(
  amountCents: number,
  item: Pick<RecurringMatchItem, "amountCents" | "tolerancePercent" | "toleranceCents">,
): boolean {
  if (Math.sign(amountCents) !== Math.sign(item.amountCents)) return false;
  return Math.abs(amountCents - item.amountCents) <= amountTolerance(item);
}

export function planRecurringLinks(input: {
  householdId: string;
  items: readonly RecurringMatchItem[];
  transactions: readonly RecurringMatchTransaction[];
  links: readonly RecurringLinkRow[];
  dismissals: readonly RecurringDismissal[];
}): RecurringLinkPlan {
  const household = input.householdId;
  const linkedTransactions = new Set(input.links.map((link) => link.transactionId));
  const filled = new Set<string>();
  const stale = new Map<string, string>();
  for (const link of input.links) {
    const key = `${link.itemId}|${link.occurrenceDate}`;
    if (link.transactionDeleted) stale.set(key, link.id);
    else filled.add(key);
  }
  const dismissed = new Set(input.dismissals.map((row) => `${row.itemId}|${row.transactionId}`));
  const live = input.transactions.filter(
    (row) => row.householdId === household && !row.deleted && !linkedTransactions.has(row.id),
  );
  type Scored = PlannedRecurringLink & { days: number; diff: number; createdAt: string };
  const scored: Scored[] = [];
  if (live.length > 0) {
    const dates = live.map((row) => row.occurredOn).sort();
    for (const item of input.items) {
      if (item.householdId !== household || item.paused) continue;
      const occurrences = occurrencesBetween(item, addDays(dates[0], -item.windowDays), addDays(dates[dates.length - 1], item.windowDays));
      if (occurrences.length === 0) continue;
      for (const row of live) {
        if (item.accountId && row.accountId !== item.accountId) continue;
        if (dismissed.has(`${item.id}|${row.id}`)) continue;
        if (!payeeMatchesItem(row.payee, item.payeeMatch) || !amountMatchesItem(row.amountCents, item)) continue;
        for (const occurrenceDate of occurrences) {
          const days = daysBetween(occurrenceDate, row.occurredOn);
          if (days > item.windowDays || filled.has(`${item.id}|${occurrenceDate}`)) continue;
          scored.push({
            itemId: item.id,
            transactionId: row.id,
            occurrenceDate,
            days,
            diff: Math.abs(row.amountCents - item.amountCents),
            createdAt: row.createdAt,
          });
        }
      }
    }
  }
  scored.sort(
    (a, b) =>
      a.days - b.days ||
      a.diff - b.diff ||
      cmp(a.itemId, b.itemId) ||
      cmp(a.createdAt, b.createdAt) ||
      cmp(a.transactionId, b.transactionId) ||
      cmp(a.occurrenceDate, b.occurrenceDate),
  );
  const usedTransactions = new Set<string>();
  const usedOccurrences = new Set<string>();
  const add: PlannedRecurringLink[] = [];
  const drop: string[] = [];
  for (const pair of scored) {
    const key = `${pair.itemId}|${pair.occurrenceDate}`;
    if (usedTransactions.has(pair.transactionId) || usedOccurrences.has(key)) continue;
    usedTransactions.add(pair.transactionId);
    usedOccurrences.add(key);
    add.push({ itemId: pair.itemId, transactionId: pair.transactionId, occurrenceDate: pair.occurrenceDate });
    const old = stale.get(key);
    if (old) drop.push(old);
  }
  return { add, drop };
}

/**
 * A member links a transaction by hand. Payee and amount are not checked (the
 * member decides); the transaction takes the nearest occurrence that no live
 * transaction holds, within one period of its date. Ties go to the earlier date.
 */
export function occurrenceForManualLink(
  item: RecurringSchedule,
  occurredOn: string,
  filledDates: ReadonlySet<string>,
): Result<string, RecurringError> {
  const reach = cadencePeriodDays(item.cadence) + 3;
  const free = occurrencesBetween(item, addDays(occurredOn, -reach), addDays(occurredOn, reach)).filter((date) => !filledDates.has(date));
  free.sort((a, b) => daysBetween(a, occurredOn) - daysBetween(b, occurredOn) || cmp(a, b));
  const found = free[0];
  if (!found) return err(new RecurringError("No open occurrence of this item is near that transaction's date."));
  return ok(found);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
