import { err, ok, type Result } from "neverthrow";
import { categoryBooksEffect } from "../categories/define";
import { InvalidEstimateError } from "../errors";
import { addDays, dayNumber, daysInMonth, isCivilDate } from "../recurring/schedule";
import { expectedRecurringAmounts, type StatusItem, type StatusLink } from "../recurring/status";

/**
 * Spend estimate (PEN-205): expected spending for the rest of this month and
 * all of next month. It is an estimate, never a closed total.
 *
 *   this month = spent so far
 *              + recurring bills still expected this month
 *              + daily pace × days left after today
 *   next month = recurring bills expected next month
 *              + daily pace × days in next month
 *
 * Spent so far is every expense through today, as on Home, recurring or not.
 * Recurring amounts come from `expectedRecurringAmounts`. A bill counts as
 * still expected while it is upcoming or due within its window. Once the
 * window closes with nothing linked it is missed and left out (reported
 * separately). A bill already paid is in spent so far, including one paid early
 * for next month, so it never counts twice.
 *
 * Daily pace is everyday spending: expense-category splits on transactions
 * that are not linked to a recurring item. Income, transfers, and recurring
 * bills are left out.
 * - Blended (at least 14 days of history before this month): a mix of this
 *   month's daily average and the daily average over the 90 days before this
 *   month. This month's share is today's day of the month ÷ days in the month,
 *   so early in the month the steadier 90-day pace dominates, and by the end
 *   this month's own pace does.
 * - Pooled (less than 14 days before this month, at least 14 days in all):
 *   the daily average over every day since the first transaction.
 * - Not enough history (under 14 days since the first transaction, or none):
 *   no pace. The estimate is recurring items only.
 * Pace is worked out per category and rounded to whole cents per day; the
 * total pace is the sum, so the categories always add up.
 *
 * Income: income so far plus recurring income still expected (this month),
 * and recurring income expected (next month). Money left is that income minus
 * the estimate, shown only when there is income to compare.
 */

export const PACE_TRAILING_DAYS = 90;
export const PACE_MIN_HISTORY_DAYS = 14;

export type EstimateSplit = {
  occurredOn: string;
  categoryId: string;
  /** Category kind: income, expense, or transfer. */
  kind: string;
  /** The split's signed amount; negative is money out. */
  amountCents: number;
  /** The transaction is linked to a recurring item, so its spending is not pace. */
  recurring: boolean;
};

export type EstimateCategory = { id: string; name: string; kind: string };

export type EstimateRecurringItem = StatusItem & { categoryId: string | null };

export type PaceBasis = "blended" | "pooled" | "not_enough_history";

export type EstimatePace = {
  basis: PaceBasis;
  dailyCents: number;
  /** Everyday spending this month through today, and its daily average over the days observed. */
  thisMonthCents: number;
  thisMonthDays: number;
  thisMonthDailyCents: number;
  /** Everyday spending in the trailing window before this month (up to 90 days), and its daily average. */
  trailingCents: number;
  trailingDays: number;
  trailingDailyCents: number;
  /** Blended only: this month's share of the pace, as a whole percent. */
  thisMonthWeightPercent: number | null;
  firstTransactionOn: string | null;
};

export type EstimateMonth = {
  /** YYYY-MM */
  month: string;
  daysInMonth: number;
  /** Pace applies to these days (after today this month; the whole month next month). */
  paceDays: number;
  spentSoFarCents: number;
  recurringExpectedCents: number;
  /** Bills already paid (part of spent so far) and bills missed (not counted). */
  recurringPaidCents: number;
  recurringMissedCents: number;
  paceCents: number;
  estimateCents: number;
  incomeSoFarCents: number;
  recurringIncomeExpectedCents: number;
  incomeCents: number;
  moneyLeftCents: number | null;
  budgetCents: number | null;
  /** Budget minus estimate: positive is under the plan. */
  underBudgetCents: number | null;
};

export type EstimateCategoryLine = {
  categoryId: string | null;
  name: string;
  thisMonth: { spentSoFarCents: number; recurringCents: number; paceCents: number; estimateCents: number };
  nextMonth: { recurringCents: number; paceCents: number; estimateCents: number };
};

export type SpendEstimate = {
  kind: "estimate";
  today: string;
  pace: EstimatePace;
  thisMonth: EstimateMonth;
  nextMonth: EstimateMonth;
  categories: EstimateCategoryLine[];
};

const UNCATEGORIZED = "Recurring, no category";

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function monthEnds(year: number, month: number): { start: string; end: string; days: number } {
  const days = daysInMonth(year, month);
  const key = monthKey(year, month);
  return { start: `${key}-01`, end: `${key}-${String(days).padStart(2, "0")}`, days };
}

function inclusiveDays(from: string, to: string): number {
  return to < from ? 0 : dayNumber(to) - dayNumber(from) + 1;
}

export function buildSpendEstimate(input: {
  today: string;
  splits: readonly EstimateSplit[];
  categories: readonly EstimateCategory[];
  firstTransactionOn: string | null;
  recurringItems: readonly EstimateRecurringItem[];
  recurringLinks: readonly StatusLink[];
  budgetCents: { thisMonth: number | null; nextMonth: number | null };
}): Result<SpendEstimate, InvalidEstimateError> {
  const today = input.today;
  if (!isCivilDate(today)) return err(new InvalidEstimateError("Today is not a calendar date."));
  if (input.firstTransactionOn != null && !isCivilDate(input.firstTransactionOn)) {
    return err(new InvalidEstimateError("The first transaction date is not a calendar date."));
  }
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const day = Number(today.slice(8, 10));
  const current = monthEnds(year, month);
  const next = month === 12 ? monthEnds(year + 1, 1) : monthEnds(year, month + 1);
  const trailingStart = addDays(current.start, -PACE_TRAILING_DAYS);
  const trailingEnd = addDays(current.start, -1);

  const first = input.firstTransactionOn;
  const thisMonthDays = first == null || first > today ? 0 : inclusiveDays(first > current.start ? first : current.start, today);
  const trailingDays = first == null || first > trailingEnd ? 0 : inclusiveDays(first > trailingStart ? first : trailingStart, trailingEnd);
  const basis: PaceBasis =
    thisMonthDays + trailingDays < PACE_MIN_HISTORY_DAYS ? "not_enough_history" : trailingDays >= PACE_MIN_HISTORY_DAYS ? "blended" : "pooled";
  const weight = day / current.days;

  // Sum spending (all, and everyday-only) per category for this month and the trailing window.
  const nameOf = new Map(input.categories.map((row) => [row.id, row.name] as const));
  const spentSoFar = new Map<string, number>();
  const everydayMonth = new Map<string, number>();
  const everydayTrailing = new Map<string, number>();
  let incomeSoFar = 0;
  const add = (map: Map<string, number>, key: string, cents: number) => map.set(key, (map.get(key) ?? 0) + cents);
  for (const split of input.splits) {
    if (!Number.isInteger(split.amountCents)) return err(new InvalidEstimateError("Amounts must be integer cents."));
    const effect = categoryBooksEffect(split.kind, split.amountCents);
    if (effect.isErr()) return err(new InvalidEstimateError(effect.error.message));
    // Counted exactly as Home counts spending (money out on expense categories).
    const spend = effect.value.spentCents;
    const inMonth = split.occurredOn >= current.start && split.occurredOn <= today;
    const inTrailing = split.occurredOn >= trailingStart && split.occurredOn <= trailingEnd;
    if (inMonth) {
      incomeSoFar += effect.value.incomeCents;
      if (spend !== 0) add(spentSoFar, split.categoryId, spend);
    }
    if (spend === 0 || split.recurring) continue;
    if (inMonth) add(everydayMonth, split.categoryId, spend);
    if (inTrailing) add(everydayTrailing, split.categoryId, spend);
  }

  const paceIds = new Set([...everydayMonth.keys(), ...everydayTrailing.keys()]);
  const dailyByCategory = new Map<string, number>();
  for (const id of paceIds) {
    const m = everydayMonth.get(id) ?? 0;
    const t = everydayTrailing.get(id) ?? 0;
    let rate = 0;
    if (basis === "blended") rate = weight * (thisMonthDays > 0 ? m / thisMonthDays : 0) + (1 - weight) * (t / trailingDays);
    else if (basis === "pooled") rate = (m + t) / (thisMonthDays + trailingDays);
    dailyByCategory.set(id, Math.round(rate));
  }
  const sum = (map: Map<string, number>) => [...map.values()].reduce((total, value) => total + value, 0);
  const dailyCents = sum(dailyByCategory);
  const monthEveryday = sum(everydayMonth);
  const trailingEveryday = sum(everydayTrailing);

  // Recurring: this month and next, with their categories.
  const recurringCategory = new Map(input.recurringItems.map((item) => [item.id, item.categoryId] as const));
  const thisRecurring = expectedRecurringAmounts({ items: input.recurringItems, links: input.recurringLinks, from: current.start, to: current.end, today });
  const nextRecurring = expectedRecurringAmounts({ items: input.recurringItems, links: input.recurringLinks, from: next.start, to: next.end, today });
  const expectedByCategory = (occurrences: typeof thisRecurring.occurrences) => {
    const map = new Map<string, number>();
    for (const row of occurrences) {
      if (row.status !== "expected" && row.status !== "upcoming") continue;
      if (row.expectedCents >= 0) continue;
      add(map, recurringCategory.get(row.itemId) ?? "", -row.expectedCents);
    }
    return map;
  };
  const thisRecurringByCategory = expectedByCategory(thisRecurring.occurrences);
  const nextRecurringByCategory = expectedByCategory(nextRecurring.occurrences);

  const daysLeft = current.days - day;
  const lines: EstimateCategoryLine[] = [];
  const ids = new Set([...spentSoFar.keys(), ...dailyByCategory.keys(), ...thisRecurringByCategory.keys(), ...nextRecurringByCategory.keys()]);
  for (const id of ids) {
    const daily = dailyByCategory.get(id) ?? 0;
    const soFar = spentSoFar.get(id) ?? 0;
    const recurringNow = thisRecurringByCategory.get(id) ?? 0;
    const recurringNext = nextRecurringByCategory.get(id) ?? 0;
    const line: EstimateCategoryLine = {
      categoryId: id === "" ? null : id,
      name: id === "" ? UNCATEGORIZED : (nameOf.get(id) ?? "Category"),
      thisMonth: { spentSoFarCents: soFar, recurringCents: recurringNow, paceCents: daily * daysLeft, estimateCents: soFar + recurringNow + daily * daysLeft },
      nextMonth: { recurringCents: recurringNext, paceCents: daily * next.days, estimateCents: recurringNext + daily * next.days },
    };
    if (line.thisMonth.estimateCents === 0 && line.nextMonth.estimateCents === 0 && soFar === 0) continue;
    lines.push(line);
  }
  lines.sort((a, b) => b.thisMonth.estimateCents - a.thisMonth.estimateCents || b.nextMonth.estimateCents - a.nextMonth.estimateCents || a.name.localeCompare(b.name));

  const spentSoFarCents = sum(spentSoFar);
  const monthOf = (
    ends: { start: string; days: number },
    paceDays: number,
    soFar: number,
    recurring: typeof thisRecurring,
    incomeSoFarCents: number,
    budget: number | null,
  ): EstimateMonth => {
    const paceCents = dailyCents * paceDays;
    const estimateCents = soFar + recurring.expected.expenseCents + paceCents;
    const incomeCents = incomeSoFarCents + recurring.expected.incomeCents;
    return {
      month: ends.start.slice(0, 7),
      daysInMonth: ends.days,
      paceDays,
      spentSoFarCents: soFar,
      recurringExpectedCents: recurring.expected.expenseCents,
      recurringPaidCents: recurring.paid.expenseCents,
      recurringMissedCents: recurring.missed.expenseCents,
      paceCents,
      estimateCents,
      incomeSoFarCents,
      recurringIncomeExpectedCents: recurring.expected.incomeCents,
      incomeCents,
      moneyLeftCents: incomeCents > 0 ? incomeCents - estimateCents : null,
      budgetCents: budget,
      underBudgetCents: budget != null && budget > 0 ? budget - estimateCents : null,
    };
  };

  return ok({
    kind: "estimate",
    today,
    pace: {
      basis,
      dailyCents,
      thisMonthCents: monthEveryday,
      thisMonthDays,
      thisMonthDailyCents: thisMonthDays > 0 ? Math.round(monthEveryday / thisMonthDays) : 0,
      trailingCents: trailingEveryday,
      trailingDays,
      trailingDailyCents: trailingDays > 0 ? Math.round(trailingEveryday / trailingDays) : 0,
      thisMonthWeightPercent: basis === "blended" ? Math.round(weight * 100) : null,
      firstTransactionOn: first,
    },
    thisMonth: monthOf(current, daysLeft, spentSoFarCents, thisRecurring, incomeSoFar, input.budgetCents.thisMonth),
    nextMonth: monthOf(next, next.days, 0, nextRecurring, 0, input.budgetCents.nextMonth),
    categories: lines,
  });
}

/** The first day the trailing pace window covers, for loading only the rows the estimate needs. */
export function estimateWindowStart(today: string): string {
  return addDays(`${today.slice(0, 7)}-01`, -PACE_TRAILING_DAYS);
}
