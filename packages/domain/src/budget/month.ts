import { err, ok, type Result } from "neverthrow";
import { BudgetError } from "../errors";
import { daysInMonth, type CivilDate } from "../history/columns";

/** A calendar month a household can budget. Years match the budget table check. */
export type BudgetMonth = {
  year: number;
  month: number;
};

const MONTH_KEY = /^(\d{4})-(\d{2})$/;
const MIN_YEAR = 2000;
const MAX_YEAR = 2200;

export function isBudgetMonth(value: { year: number; month: number }): value is BudgetMonth {
  return (
    Number.isInteger(value.year) &&
    Number.isInteger(value.month) &&
    value.year >= MIN_YEAR &&
    value.year <= MAX_YEAR &&
    value.month >= 1 &&
    value.month <= 12
  );
}

export function assertBudgetMonth(value: { year: number; month: number }): Result<BudgetMonth, BudgetError> {
  if (!isBudgetMonth(value)) return err(new BudgetError("Choose a month."));
  return ok(value);
}

/** `YYYY-MM`, the value a month input and the plan URL share. */
export function formatBudgetMonth(month: BudgetMonth): string {
  return `${month.year}-${String(month.month).padStart(2, "0")}`;
}

export function parseBudgetMonth(raw: string): Result<BudgetMonth, BudgetError> {
  const match = raw.trim().match(MONTH_KEY);
  if (!match) return err(new BudgetError("Choose a month."));
  return assertBudgetMonth({ year: Number(match[1]), month: Number(match[2]) });
}

export function shiftBudgetMonth(month: BudgetMonth, delta: number): Result<BudgetMonth, BudgetError> {
  if (!Number.isInteger(delta)) return err(new BudgetError("Choose a month."));
  const index = month.year * 12 + (month.month - 1) + delta;
  const next = { year: Math.floor(index / 12), month: (index % 12) + 1 };
  return assertBudgetMonth(next);
}

/**
 * Inclusive last day of spending for a plan month.
 * The current month stops at today. Every other month uses its full length.
 */
export function planThroughDate(month: BudgetMonth, asOf: CivilDate): CivilDate {
  const last = daysInMonth(month.year, month.month);
  if (asOf.year === month.year && asOf.month === month.month) {
    const day = Number.isInteger(asOf.day) ? Math.min(Math.max(asOf.day, 1), last) : last;
    return { year: month.year, month: month.month, day };
  }
  return { year: month.year, month: month.month, day: last };
}
