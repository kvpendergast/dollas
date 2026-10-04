import { err, ok, type Result } from "neverthrow";
import { InvalidHistoryError } from "../errors";

/** Calendar date in the household timezone. Month is 1–12. */
export type CivilDate = {
  year: number;
  month: number;
  day: number;
};

export type ExpenseLine = {
  /** ISO date `YYYY-MM-DD` in the household timezone. */
  occurredOn: string;
  /** Positive cents spent. Income is not part of this history. */
  spentCents: number;
};

export type SpendDirection = "less" | "more" | "same";

export type MonthChange = {
  deltaCents: number;
  direction: SpendDirection;
};

/**
 * Year-over-year for a finished month carries a dollar delta.
 * The current month is unfinished, so it has no dollar delta at all.
 */
export type YearOverYear =
  | { comparable: false; label: "Not comparable yet" }
  | { comparable: true; deltaCents: number; direction: SpendDirection };

export type HistoryColumn = {
  year: number;
  month: number;
  spentCents: number;
  priorYearSpentCents: number;
  partial: boolean;
  partialLabel: "so far" | null;
  monthOverMonth: MonthChange;
  yearOverYear: YearOverYear;
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function isPartialMonth(month: Pick<CivilDate, "year" | "month">, asOf: CivilDate): boolean {
  return month.year === asOf.year && month.month === asOf.month;
}

export function spendDirection(deltaCents: number): SpendDirection {
  if (deltaCents < 0) return "less";
  if (deltaCents > 0) return "more";
  return "same";
}

function parseDate(value: string): CivilDate | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function sumThroughDay(
  totals: Map<string, number>,
  year: number,
  month: number,
  throughDay: number,
): number {
  let spent = 0;
  const last = Math.min(throughDay, daysInMonth(year, month));
  for (let day = 1; day <= last; day += 1) {
    const key = `${monthKey(year, month)}-${String(day).padStart(2, "0")}`;
    spent += totals.get(key) ?? 0;
  }
  return spent;
}

function sumMonth(totals: Map<string, number>, year: number, month: number): number {
  return sumThroughDay(totals, year, month, daysInMonth(year, month));
}

/**
 * Build trailing month columns from expense lines.
 * The current month stays partial: its bar is "so far", and year-over-year
 * is "Not comparable yet" with no dollar delta. Month-over-month for that
 * column compares the same elapsed days, so a partial month is not treated
 * as a finished total.
 */
export function buildSpendingHistory(input: {
  expenses: readonly ExpenseLine[];
  asOf: CivilDate;
  monthCount?: number;
}): Result<HistoryColumn[], InvalidHistoryError> {
  const monthCount = input.monthCount ?? 12;
  if (!Number.isInteger(monthCount) || monthCount < 1 || monthCount > 36) {
    return err(new InvalidHistoryError("History length must be between 1 and 36 months."));
  }
  if (input.asOf.month < 1 || input.asOf.month > 12 || input.asOf.day < 1) {
    return err(new InvalidHistoryError("asOf is not a calendar date."));
  }
  if (input.asOf.day > daysInMonth(input.asOf.year, input.asOf.month)) {
    return err(new InvalidHistoryError("asOf is not a calendar date."));
  }

  const byDay = new Map<string, number>();
  for (const line of input.expenses) {
    if (!Number.isInteger(line.spentCents) || line.spentCents < 0) {
      return err(new InvalidHistoryError("Spent amounts must be non-negative integer cents."));
    }
    const date = parseDate(line.occurredOn);
    if (!date) {
      return err(new InvalidHistoryError(`Invalid expense date ${line.occurredOn}.`));
    }
    byDay.set(line.occurredOn, (byDay.get(line.occurredOn) ?? 0) + line.spentCents);
  }

  const columns: HistoryColumn[] = [];
  const start = addMonths(input.asOf.year, input.asOf.month, -(monthCount - 1));

  for (let index = 0; index < monthCount; index += 1) {
    const cursor = addMonths(start.year, start.month, index);
    const partial = isPartialMonth(cursor, input.asOf);
    const spentCents = partial
      ? sumThroughDay(byDay, cursor.year, cursor.month, input.asOf.day)
      : sumMonth(byDay, cursor.year, cursor.month);
    const prior = { year: cursor.year - 1, month: cursor.month };
    const priorYearSpentCents = sumMonth(byDay, prior.year, prior.month);

    const previous = addMonths(cursor.year, cursor.month, -1);
    const previousSpent = partial
      ? sumThroughDay(byDay, previous.year, previous.month, input.asOf.day)
      : sumMonth(byDay, previous.year, previous.month);
    const momDelta = spentCents - previousSpent;

    const yearOverYear: YearOverYear = partial
      ? { comparable: false, label: "Not comparable yet" }
      : {
          comparable: true,
          deltaCents: spentCents - priorYearSpentCents,
          direction: spendDirection(spentCents - priorYearSpentCents),
        };

    columns.push({
      year: cursor.year,
      month: cursor.month,
      spentCents,
      priorYearSpentCents,
      partial,
      partialLabel: partial ? "so far" : null,
      monthOverMonth: { deltaCents: momDelta, direction: spendDirection(momDelta) },
      yearOverYear,
    });
  }

  return ok(columns);
}
