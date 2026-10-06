import { err, ok, type Result } from "neverthrow";
import { InvalidMoneyError } from "../errors";
import { parseDollarInput } from "../money/cents";

export type BudgetAmountDecision = { action: "clear" } | { action: "set"; amountCents: number };

/**
 * An empty budget field clears the month. A typed amount, including zero, is saved.
 * Negative amounts are rejected so clearing stays a blank field, not a minus sign.
 */
export function decideBudgetAmount(raw: string): Result<BudgetAmountDecision, InvalidMoneyError> {
  if (raw.trim().length === 0) return ok({ action: "clear" });
  const parsed = parseDollarInput(raw);
  if (parsed.isErr()) return err(parsed.error);
  if (parsed.value < 0) return err(new InvalidMoneyError("A budget cannot be negative."));
  return ok({ action: "set", amountCents: parsed.value });
}
