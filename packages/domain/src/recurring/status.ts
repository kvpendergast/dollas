import type { Cents } from "../money/cents";
import { addDays, nextOccurrences, occurrencesBetween, type RecurringSchedule } from "./schedule";

/**
 * Occurrence status (PEN-206):
 * - paid (bill) / received (income): a live transaction is linked to it;
 * - missed: nothing linked and today is past the date plus the window;
 * - expected: nothing linked yet and today is within the window of the date;
 * - upcoming: the date (less the window) is still ahead.
 * A paused item lists its paid history but expects nothing new.
 */
export type OccurrenceStatus = "paid" | "received" | "expected" | "missed" | "upcoming";

export type StatusItem = RecurringSchedule & {
  id: string;
  name: string;
  amountCents: Cents;
  windowDays: number;
  paused: boolean;
};

export type StatusLink = {
  itemId: string;
  occurrenceDate: string;
  transactionId: string;
  occurredOn: string;
  payee: string;
  amountCents: Cents;
  deleted: boolean;
};

export type RecurringOccurrence = {
  itemId: string;
  date: string;
  expectedCents: Cents;
  status: OccurrenceStatus;
  transaction: { id: string; occurredOn: string; payee: string; amountCents: Cents } | null;
};

export function occurrenceStatus(item: Pick<StatusItem, "amountCents" | "windowDays">, date: string, linked: boolean, today: string): OccurrenceStatus {
  if (linked) return item.amountCents > 0 ? "received" : "paid";
  if (today > addDays(date, item.windowDays)) return "missed";
  if (today >= addDays(date, -item.windowDays)) return "expected";
  return "upcoming";
}

/** Every occurrence of one item from `from` to `to`, with its status and linked transaction. */
export function itemOccurrences(
  item: StatusItem,
  links: readonly StatusLink[],
  from: string,
  to: string,
  today: string,
): RecurringOccurrence[] {
  const byDate = new Map<string, StatusLink>();
  for (const link of links) {
    if (link.itemId === item.id && !link.deleted) byDate.set(link.occurrenceDate, link);
  }
  const dates = new Set(occurrencesBetween(item, from, to));
  for (const date of byDate.keys()) if (date >= from && date <= to) dates.add(date);
  const out: RecurringOccurrence[] = [];
  for (const date of [...dates].sort()) {
    const link = byDate.get(date) ?? null;
    if (!link && item.paused) continue;
    out.push({
      itemId: item.id,
      date,
      expectedCents: item.amountCents,
      status: occurrenceStatus(item, date, link != null, today),
      transaction: link ? { id: link.transactionId, occurredOn: link.occurredOn, payee: link.payee, amountCents: link.amountCents } : null,
    });
  }
  return out;
}

/** The next expected date on or after today that nothing is linked to yet, or null (paused or ended). */
export function nextExpectedDate(item: StatusItem, links: readonly StatusLink[], today: string): string | null {
  if (item.paused) return null;
  const linked = new Set(links.filter((link) => link.itemId === item.id && !link.deleted).map((link) => link.occurrenceDate));
  const from = addDays(today, -item.windowDays);
  return nextOccurrences(item, from, 24).find((date) => !linked.has(date) && addDays(date, item.windowDays) >= today) ?? null;
}

export type RecurringTotals = { incomeCents: Cents; expenseCents: Cents; count: number };

export type ExpectedRecurring = {
  occurrences: RecurringOccurrence[];
  /** Linked transactions in the range, at their actual amounts. Magnitudes. */
  paid: RecurringTotals;
  /** Unlinked occurrences still ahead or due now (expected or upcoming), at the item's amount. Magnitudes. */
  expected: RecurringTotals;
  /** Unlinked occurrences already past their window. Not in `expected`. Magnitudes. */
  missed: RecurringTotals;
};

/**
 * Expected recurring amounts for a date range, split into already paid and
 * still expected. PEN-205's projection uses this: `expected` is what known
 * bills and paychecks still add to the range, and `paid` is what already
 * landed (so it is not counted twice against the pace of other spending).
 */
export function expectedRecurringAmounts(input: {
  items: readonly StatusItem[];
  links: readonly StatusLink[];
  from: string;
  to: string;
  today: string;
}): ExpectedRecurring {
  const occurrences = input.items
    .flatMap((item) => itemOccurrences(item, input.links, input.from, input.to, input.today))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.itemId < b.itemId ? -1 : 1));
  const totals = (): RecurringTotals => ({ incomeCents: 0, expenseCents: 0, count: 0 });
  const paid = totals();
  const expected = totals();
  const missed = totals();
  for (const occurrence of occurrences) {
    const bucket =
      occurrence.status === "paid" || occurrence.status === "received" ? paid : occurrence.status === "missed" ? missed : expected;
    const cents = occurrence.transaction ? occurrence.transaction.amountCents : occurrence.expectedCents;
    if (cents > 0) bucket.incomeCents += cents;
    else bucket.expenseCents += -cents;
    bucket.count += 1;
  }
  return { occurrences, paid, expected, missed };
}

export type AmountChange = { fromCents: Cents; toCents: Cents; on: string; direction: "increase" | "decrease" };

export type ItemHealth = {
  /** Unlinked occurrences in a row, newest back, each already past its window. */
  missedInARow: number;
  /** Not paused, at least two in a row missed, and something was linked before. */
  likelyCancelled: boolean;
  lastLinkedOn: string | null;
  /** The newest charge differs from the typical earlier ones (a price change). Null for items that vary by design or when the change is old. */
  amountChange: AmountChange | null;
};

/** A change older than this is history, not news. */
export const AMOUNT_CHANGE_RECENT_DAYS = 90;
/** Items with a wide tolerance vary by design (hourly pay, usage bills): no price-change flag. */
export const AMOUNT_CHANGE_MAX_TOLERANCE_PERCENT = 10;

/**
 * Two signals for an existing item (PEN-326): a likely cancellation (the last two or more
 * expected charges never came) and a recent amount change (the newest linked charge is not
 * the usual one: at least 1 percent and 100 cents off the median of the up to three before it).
 */
export function itemHealth(item: StatusItem & { tolerancePercent: number }, links: readonly StatusLink[], today: string): ItemHealth {
  const mine = links.filter((link) => link.itemId === item.id && !link.deleted).sort((a, b) => (a.occurredOn < b.occurredOn ? -1 : a.occurredOn > b.occurredOn ? 1 : 0));
  const linkedDates = new Set(mine.map((link) => link.occurrenceDate));
  const past = occurrencesBetween(item, addDays(today, -800), addDays(today, -item.windowDays - 1)).reverse();
  let missedInARow = 0;
  for (const date of past) {
    if (linkedDates.has(date)) break;
    missedInARow += 1;
  }
  const lastLinkedOn = mine.length > 0 ? mine[mine.length - 1].occurredOn : null;
  const likelyCancelled = !item.paused && missedInARow >= 2 && lastLinkedOn !== null;

  let amountChange: AmountChange | null = null;
  if (mine.length >= 2 && item.tolerancePercent <= AMOUNT_CHANGE_MAX_TOLERANCE_PERCENT) {
    const latest = mine[mine.length - 1];
    const earlier = mine.slice(Math.max(0, mine.length - 4), mine.length - 1).map((link) => link.amountCents).sort((a, b) => a - b);
    const typical = earlier[Math.floor(earlier.length / 2)];
    const diff = latest.amountCents - typical;
    const recent = latest.occurredOn >= addDays(today, -AMOUNT_CHANGE_RECENT_DAYS);
    if (recent && Math.abs(diff) >= 100 && Math.abs(diff) * 100 >= Math.abs(typical)) {
      // Bills are negative: a more negative amount is an increase in what is paid.
      const grew = Math.abs(latest.amountCents) > Math.abs(typical);
      amountChange = { fromCents: typical, toCents: latest.amountCents, on: latest.occurredOn, direction: grew ? "increase" : "decrease" };
    }
  }
  return { missedInARow, likelyCancelled, lastLinkedOn, amountChange };
}
