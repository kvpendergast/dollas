import type { Cents } from "../money/cents";
import { payeeRuleKey } from "../rules/payee-category";
import { RECURRING_LIMITS } from "./define";
import { addDays, dayNumber, type Cadence } from "./schedule";

/**
 * "Make recurring" suggestions (PEN-206): payees in recent history that look
 * like a bill or paycheck. A group is one normalized payee (lowercase, digits
 * and punctuation dropped) and one sign. It qualifies with at least three live
 * transactions in the lookback, at least three quarters of the gaps between
 * them in one cadence band (or, for a bill that moves around the month,
 * one charge per calendar month with the day of month within a window),
 * every amount within 10% of the median (the
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
  /** The one account every matching charge is on, or null when the bill appears on several (the item then matches any account). */
  accountId: string | null;
  /** Every account a matching charge appears on, sorted. */
  accountIds: string[];
  categoryId: string | null;
  /** Wide enough for the spread seen (5 or 10 percent; up to 50 for a paycheck that varies). */
  tolerancePercent: number;
  /** True when the amounts vary a lot (income only), so the item matches a range around the typical amount. */
  variableAmount: boolean;
  /** Every live charge in the lookback this suggestion's payee text would link, not just the ones that formed the series. */
  count: number;
};

/** A monthly bill may land on a different day each month (weekends, grace days). */
const MONTHLY_DAY_WINDOW = 10;

const MONTHLY_BAND = { cadence: "monthly" as Cadence, min: 27, max: 34 };

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
  const live: SuggestionTransaction[] = [];
  for (const row of input.transactions) {
    if (row.deleted || row.amountCents === 0 || row.occurredOn < since || row.occurredOn > input.today) continue;
    live.push(row);
    // Variants of one payer ("PEO ACME PAYROLL PPD ID 12", "ACME PAYROLL ACH") share the cleaned name.
    const cleaned = cleanSuggestionName(row.payee).toLowerCase();
    const key = cleaned.length >= 2 ? cleaned : normalizedPayee(row.payee);
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
    const band =
      BANDS.find((candidate) => gaps.filter((gap) => gap >= candidate.min && gap <= candidate.max).length >= Math.ceil(gaps.length * 0.75)) ??
      (isMonthlyByCalendar(rows) ? MONTHLY_BAND : undefined);
    if (!band) continue;
    const amounts = rows.map((row) => row.amountCents).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)];
    const spread = Math.max(...amounts.map((amount) => Math.abs(amount - median) / Math.abs(median)));
    // Pay that varies (hours, bonuses) is still a paycheck: income may swing up to 50% and is matched as a range.
    const variableAmount = spread > 0.1 && Math.sign(median) > 0 && spread <= RECURRING_LIMITS.tolerancePercent / 100;
    if (spread > 0.1 && !variableAmount) continue;
    const last = rows[rows.length - 1];
    if (dayNumber(input.today) - dayNumber(last.occurredOn) > band.max * 2) continue;
    const payees = rows.map((row) => row.payee);
    const prefix = commonPrefix(payees);
    const phrase = commonPhrase(payees);
    const payeeMatch = (phrase.length > prefix.length ? phrase : prefix) || last.payee.trim();
    let secondDayOfMonth: number | null = null;
    if (band.cadence === "semimonthly") {
      const lastDay = Number(last.occurredOn.slice(8, 10));
      const other = rows.map((row) => Number(row.occurredOn.slice(8, 10))).filter((day) => Math.abs(day - lastDay) >= 7);
      secondDayOfMonth = mostCommon(other) ?? (lastDay > 15 ? lastDay - 15 : lastDay + 15);
    }
    const needle = payeeMatch.toLowerCase();
    const sign = Math.sign(last.amountCents);
    const matching = live.filter((row) => Math.sign(row.amountCents) === sign && row.payee.toLowerCase().includes(needle));
    const count = matching.length;
    const accountIds = [...new Set([...matching, ...rows].map((row) => row.accountId))].sort();
    out.push({
      name: cleanSuggestionName(last.payee),
      payeeMatch,
      amountCents: median,
      cadence: band.cadence,
      anchorDate: last.occurredOn,
      secondDayOfMonth,
      accountId: accountIds.length === 1 ? accountIds[0] : null,
      accountIds,
      categoryId: mostCommon(rows.map((row) => row.categoryId).filter((id): id is string => id != null)) ?? null,
      tolerancePercent: variableAmount ? Math.min(RECURRING_LIMITS.tolerancePercent, Math.ceil((spread * 100) / 5) * 5) : spread > 0.05 ? 10 : 5,
      variableAmount,
      count: Math.max(count, rows.length),
    });
  }
  return out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * One charge a month for consecutive calendar months, with the day of month inside a window
 * (a mortgage on the 1st to the 4th, a card on the 20th to the 28th). Needs three months and
 * at least three quarters of the month-to-month steps to be exactly one month.
 */
function isMonthlyByCalendar(rows: readonly SuggestionTransaction[]): boolean {
  const months = [...new Set(rows.map((row) => row.occurredOn.slice(0, 7)))];
  if (months.length < 3) return false;
  const index = (key: string) => Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7));
  const steps = months.slice(1).map((key, i) => index(key) - index(months[i]));
  if (steps.filter((step) => step === 1).length < Math.ceil(steps.length * 0.75)) return false;
  if (rows.length > months.length * 1.25) return false;
  const days = rows.map((row) => Number(row.occurredOn.slice(8, 10))).sort((a, b) => a - b);
  const median = days[Math.floor(days.length / 2)];
  // Month ends wrap: 30th and 2nd are four days apart.
  const apart = (day: number) => Math.min(Math.abs(day - median), 30 - Math.abs(day - median));
  return days.every((day) => apart(day) <= MONTHLY_DAY_WINDOW);
}

/**
 * The longest run of whole words that every payee contains (case-insensitive), at least four
 * letters. Lets variants like "PEO ACME INC PAYROLL" and "ACME PAYROLL ACH" share one match text.
 */
function commonPhrase(payees: readonly string[]): string {
  const first = payees[0]?.trim().split(/\s+/) ?? [];
  const lowered = payees.map((payee) => payee.toLowerCase());
  for (let length = first.length; length >= 1; length -= 1) {
    for (let start = 0; start + length <= first.length; start += 1) {
      const phrase = first.slice(start, start + length).join(" ").replace(/[\s\W\d]+$/, "");
      if (phrase.replace(/[^a-zA-Z]/g, "").length < 4) continue;
      if (lowered.every((payee) => payee.includes(phrase.toLowerCase()))) return phrase;
    }
  }
  return "";
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

/** Bank processor words that say how a charge moved, not who it was for. */
const NOISE = new Set(["ppd", "id", "ach", "web", "ccd", "peo", "tel", "pos", "debit", "credit", "purchase", "pmt", "autopay", "recurring", "sq", "tst", "pp", "paypal", "inc", "llc", "corp", "co", "ltd", "com", "www"]);

/**
 * A readable name from the payee text the item will match on: processor words, company suffixes,
 * ids and single letters are dropped ("PEO UNITYAI INC PAYROLL PPD ID" -> "Unityai Payroll").
 * The raw text stays the match pattern; this is only the label.
 */
export function cleanSuggestionName(payeeMatch: string): string {
  const words = payeeMatch
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !/\d/.test(word) && !NOISE.has(word));
  const text = words.length > 0 ? words.join(" ") : payeeMatch.toLowerCase().replace(/[^a-z]+/g, " ").trim();
  return text
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
