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
