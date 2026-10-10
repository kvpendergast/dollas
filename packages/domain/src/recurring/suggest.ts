import type { Cents } from "../money/cents";
import { payeeRuleKey } from "../rules/payee-category";
import { addDays, dayNumber, type Cadence } from "./schedule";

/**
 * "Make recurring" suggestions (PEN-206): payees in recent history that look
 * like a bill or paycheck. A group is one normalized payee (lowercase, digits
 * and punctuation dropped) and one sign. It qualifies with at least three live
 * transactions in the lookback, at least three quarters of the gaps between
 * them in one cadence band, every amount within 10% of the median (the
 * suggested tolerance covers the spread), and a last
 * charge recent enough that it has not stopped. Payees an item already covers
 * are left out. Yearly and quarterly need more history than the lookback, so
 * they are not suggested.
 */
export type SuggestionTransaction = {
  payee: string;
  amountCents: Cents;
  occurredOn: string;
  accountId: string;
  categoryId: string | null;
  deleted: boolean;
};

export type RecurringSuggestion = {
  name: string;
  payeeMatch: string;
  amountCents: Cents;
  cadence: Cadence;
  anchorDate: string;
  secondDayOfMonth: number | null;
  accountId: string | null;
  categoryId: string | null;
  /** Wide enough for the spread seen (5 or 10 percent). */
  tolerancePercent: number;
  count: number;
};

const BANDS: ReadonlyArray<{ cadence: Cadence; min: number; max: number }> = [
  { cadence: "weekly", min: 6, max: 8 },
  { cadence: "biweekly", min: 13, max: 15 },
  { cadence: "semimonthly", min: 12, max: 19 },
  { cadence: "monthly", min: 27, max: 34 },
];

export function normalizedPayee(payee: string): string {
  return payee.toLowerCase().replace(/[^a-z]+/g, " ").replace(/\s+/g, " ").trim();
}

export function suggestRecurringItems(input: {
  transactions: readonly SuggestionTransaction[];
  existingPayeeMatches: readonly string[];
  today: string;
  lookbackDays?: number;
}): RecurringSuggestion[] {
  const since = addDays(input.today, -(input.lookbackDays ?? 200));
  const covered = input.existingPayeeMatches.map((match) => payeeRuleKey(match)).filter((key) => key.length > 0);
  const groups = new Map<string, SuggestionTransaction[]>();
  for (const row of input.transactions) {
    if (row.deleted || row.amountCents === 0 || row.occurredOn < since || row.occurredOn > input.today) continue;
    const key = normalizedPayee(row.payee);
    if (key.length < 2) continue;
    const lower = row.payee.toLowerCase();
    if (covered.some((match) => lower.includes(match))) continue;
    const group = `${key}|${Math.sign(row.amountCents)}`;
    const list = groups.get(group) ?? [];
    list.push(row);
    groups.set(group, list);
  }
  const out: RecurringSuggestion[] = [];
  for (const rows of groups.values()) {
    if (rows.length < 3) continue;
    rows.sort((a, b) => (a.occurredOn < b.occurredOn ? -1 : a.occurredOn > b.occurredOn ? 1 : 0));
    const gaps = rows.slice(1).map((row, index) => dayNumber(row.occurredOn) - dayNumber(rows[index].occurredOn));
    const band = BANDS.find((candidate) => gaps.filter((gap) => gap >= candidate.min && gap <= candidate.max).length >= Math.ceil(gaps.length * 0.75));
    if (!band) continue;
    const amounts = rows.map((row) => row.amountCents).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)];
    const spread = Math.max(...amounts.map((amount) => Math.abs(amount - median) / Math.abs(median)));
    if (spread > 0.1) continue;
    const last = rows[rows.length - 1];
    if (dayNumber(input.today) - dayNumber(last.occurredOn) > band.max * 2) continue;
    const payeeMatch = commonPrefix(rows.map((row) => row.payee)) || last.payee.trim();
    let secondDayOfMonth: number | null = null;
    if (band.cadence === "semimonthly") {
      const lastDay = Number(last.occurredOn.slice(8, 10));
      const other = rows.map((row) => Number(row.occurredOn.slice(8, 10))).filter((day) => Math.abs(day - lastDay) >= 7);
      secondDayOfMonth = mostCommon(other) ?? (lastDay > 15 ? lastDay - 15 : lastDay + 15);
    }
    out.push({
      name: titleCase(payeeMatch),
      payeeMatch,
      amountCents: median,
      cadence: band.cadence,
      anchorDate: last.occurredOn,
      secondDayOfMonth,
      accountId: allSame(rows.map((row) => row.accountId)),
      categoryId: mostCommon(rows.map((row) => row.categoryId).filter((id): id is string => id != null)) ?? null,
      tolerancePercent: spread > 0.05 ? 10 : 5,
      count: rows.length,
    });
  }
  return out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** The shared start of the payees, cut back to whole words, if it is at least three letters. */
function commonPrefix(payees: readonly string[]): string {
  let prefix = payees[0]?.trim() ?? "";
  for (const payee of payees.slice(1)) {
    const text = payee.trim();
    let i = 0;
    while (i < prefix.length && i < text.length && prefix[i].toLowerCase() === text[i].toLowerCase()) i += 1;
    prefix = prefix.slice(0, i);
  }
  const whole = payees.every((payee) => payee.trim().length === prefix.length) ? prefix : prefix.replace(/[^A-Za-z]*\S*$/, "");
  const trimmed = whole.replace(/[\s\W\d]+$/, "").trim();
  return trimmed.replace(/[^a-zA-Z]/g, "").length >= 3 ? trimmed : "";
}

function titleCase(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    .slice(0, 80);
}

function mostCommon<T>(values: readonly T[]): T | null {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: T | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function allSame(values: readonly string[]): string | null {
  return values.every((value) => value === values[0]) ? (values[0] ?? null) : null;
}
