import { err, ok, type Result } from "neverthrow";
import { InvalidEstimateError } from "../errors";
import type { CivilDate } from "../history/columns";
import { daysInMonth } from "../history/columns";

export type SpendEstimate = {
  kind: "estimate";
  spentSoFarCents: number;
  estimateCents: number;
  daysElapsed: number;
  daysInMonth: number;
  daysRemaining: number;
  dailyPaceCents: number;
};

/**
 * Project the current month from the pace of money already spent.
 * This is an estimate, not a closed month.
 */
export function estimateMonthSpend(input: {
  spentSoFarCents: number;
  asOf: CivilDate;
}): Result<SpendEstimate, InvalidEstimateError> {
  if (!Number.isInteger(input.spentSoFarCents) || input.spentSoFarCents < 0) {
    return err(new InvalidEstimateError("Spent so far must be non-negative integer cents."));
  }
  const length = daysInMonth(input.asOf.year, input.asOf.month);
  if (input.asOf.month < 1 || input.asOf.month > 12 || input.asOf.day < 1 || input.asOf.day > length) {
    return err(new InvalidEstimateError("asOf is not a calendar date."));
  }
  const daysElapsed = input.asOf.day;
  const estimateCents = Math.round((input.spentSoFarCents * length) / daysElapsed);
  const dailyPaceCents = Math.round(input.spentSoFarCents / daysElapsed);
  return ok({
    kind: "estimate",
    spentSoFarCents: input.spentSoFarCents,
    estimateCents,
    daysElapsed,
    daysInMonth: length,
    daysRemaining: length - daysElapsed,
    dailyPaceCents,
  });
}
