import { parseDollarInput, type RecurringItemInput } from "@dollas/domain";

/**
 * Reads the Recurring form. Amounts arrive as dollars and leave as signed
 * integer cents (a bill is negative). Validation beyond parsing is the
 * domain's defineRecurringItem, which the service runs.
 */
export function readRecurringForm(formData: FormData): { error: string } | { input: RecurringItemInput } {
  const text = (key: string) => String(formData.get(key) ?? "").trim();
  const whole = (key: string): number | null => {
    const raw = text(key);
    if (raw === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : Number.NaN;
  };
  const amount = parseDollarInput(text("amount"));
  if (amount.isErr()) return { error: amount.error.message };
  if (amount.value <= 0) return { error: "Enter an amount greater than zero." };
  const range = text("toleranceAmount");
  let toleranceCents = 0;
  if (range !== "") {
    const parsed = parseDollarInput(range);
    if (parsed.isErr()) return { error: "Enter the fixed amount range in dollars." };
    toleranceCents = parsed.value;
  }
  const direction = text("direction") === "income" ? 1 : -1;
  return {
    input: {
      name: text("name"),
      payeeMatch: text("payeeMatch") || null,
      amountCents: amount.value * direction,
      cadence: text("cadence"),
      anchorDate: text("anchorDate"),
      dayOfMonth: whole("dayOfMonth"),
      secondDayOfMonth: whole("secondDayOfMonth"),
      categoryId: text("categoryId") || null,
      accountId: text("accountId") || null,
      tolerancePercent: whole("tolerancePercent"),
      toleranceCents,
      windowDays: whole("windowDays"),
      startDate: text("startDate") || null,
      endDate: text("endDate") || null,
    },
  };
}
