import { err, ok, type Result } from "neverthrow";
import { RecurringError } from "../errors";
import { isCents, type Cents } from "../money/cents";
import { isCadence, isCivilDate, type Cadence, type RecurringSchedule } from "./schedule";

export const RECURRING_DEFAULTS = { tolerancePercent: 5, toleranceCents: 0, windowDays: 3 } as const;
export const RECURRING_LIMITS = { tolerancePercent: 50, toleranceCents: 100_000_00, windowDays: 10, amountCents: 1_000_000_00 } as const;

export type RecurringItemInput = {
  name: string;
  /** Text a matching payee contains; ignores case. Defaults to the name. */
  payeeMatch?: string | null;
  /** Signed cents: negative is a bill (money out), positive is income. */
  amountCents: number;
  cadence: string;
  anchorDate: string;
  dayOfMonth?: number | null;
  secondDayOfMonth?: number | null;
  categoryId?: string | null;
  accountId?: string | null;
  tolerancePercent?: number | null;
  toleranceCents?: number | null;
  windowDays?: number | null;
  startDate?: string | null;
  endDate?: string | null;
};

export type RecurringItemDefinition = RecurringSchedule & {
  name: string;
  payeeMatch: string;
  amountCents: Cents;
  categoryId: string | null;
  accountId: string | null;
  tolerancePercent: number;
  toleranceCents: number;
  windowDays: number;
};

const MONTHLY: readonly Cadence[] = ["semimonthly", "monthly", "quarterly", "yearly"];

/** Validate and normalize a recurring item. Every message is safe to show a member. */
export function defineRecurringItem(input: RecurringItemInput): Result<RecurringItemDefinition, RecurringError> {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length < 1) return err(new RecurringError("Enter a name."));
  if (name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) return err(new RecurringError("Use a shorter name."));
  const payeeMatch = (input.payeeMatch ?? "").trim() || name;
  if (payeeMatch.length < 2) return err(new RecurringError("Enter at least two letters of the payee to match."));
  if (payeeMatch.length > 200 || /[\u0000-\u001f\u007f]/.test(payeeMatch)) return err(new RecurringError("Use a shorter payee match."));
  if (!isCents(input.amountCents) || input.amountCents === 0 || Math.abs(input.amountCents) > RECURRING_LIMITS.amountCents) {
    return err(new RecurringError("Enter an amount greater than zero."));
  }
  if (!isCadence(input.cadence)) return err(new RecurringError("Choose how often it repeats."));
  const cadence = input.cadence;
  if (!isCivilDate(input.anchorDate)) return err(new RecurringError("Choose the date of one occurrence."));
  const monthly = MONTHLY.includes(cadence);
  const dayOfMonth = monthly ? (input.dayOfMonth ?? null) : null;
  if (dayOfMonth != null && !isDay(dayOfMonth)) return err(new RecurringError("Choose a day of the month from 1 to 31."));
  let secondDayOfMonth: number | null = null;
  if (cadence === "semimonthly") {
    secondDayOfMonth = input.secondDayOfMonth ?? null;
    if (secondDayOfMonth == null || !isDay(secondDayOfMonth)) return err(new RecurringError("Choose the second day of the month."));
    const first = dayOfMonth ?? Number(input.anchorDate.slice(8, 10));
    if (secondDayOfMonth === first) return err(new RecurringError("Twice a month needs two different days."));
  }
  const tolerancePercent = input.tolerancePercent ?? RECURRING_DEFAULTS.tolerancePercent;
  if (!Number.isInteger(tolerancePercent) || tolerancePercent < 0 || tolerancePercent > RECURRING_LIMITS.tolerancePercent) {
    return err(new RecurringError(`Amount tolerance must be 0 to ${RECURRING_LIMITS.tolerancePercent} percent.`));
  }
  const toleranceCents = input.toleranceCents ?? RECURRING_DEFAULTS.toleranceCents;
  if (!Number.isInteger(toleranceCents) || toleranceCents < 0 || toleranceCents > RECURRING_LIMITS.toleranceCents) {
    return err(new RecurringError("Enter a fixed amount range of zero or more."));
  }
  const windowDays = input.windowDays ?? RECURRING_DEFAULTS.windowDays;
  if (!Number.isInteger(windowDays) || windowDays < 0 || windowDays > RECURRING_LIMITS.windowDays) {
    return err(new RecurringError(`The date window must be 0 to ${RECURRING_LIMITS.windowDays} days.`));
  }
  const startDate = input.startDate || input.anchorDate;
  if (!isCivilDate(startDate)) return err(new RecurringError("Choose a start date."));
  const endDate = input.endDate || null;
  if (endDate != null && (!isCivilDate(endDate) || endDate < startDate)) {
    return err(new RecurringError("The end date must be on or after the start date."));
  }
  return ok({
    name,
    payeeMatch,
    amountCents: input.amountCents,
    cadence,
    anchorDate: input.anchorDate,
    dayOfMonth,
    secondDayOfMonth,
    categoryId: input.categoryId || null,
    accountId: input.accountId || null,
    tolerancePercent,
    toleranceCents,
    windowDays,
    startDate,
    endDate,
  });
}

function isDay(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 31;
}
