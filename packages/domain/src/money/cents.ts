import { err, ok, type Result } from "neverthrow";
import { InvalidMoneyError } from "../errors";

/** Whole cents. Never a float. Positive is inflow, negative is outflow. */
export type Cents = number;

export function isCents(value: number): value is Cents {
  return Number.isInteger(value);
}

export function assertCents(value: number): Result<Cents, InvalidMoneyError> {
  if (!isCents(value)) {
    return err(new InvalidMoneyError("Money must be an integer number of cents."));
  }
  return ok(value);
}

/**
 * Parse a dollar input such as "12.34", "$1,200", or "12" into integer cents.
 * More than two decimal places is rejected so we never round hidden fractions.
 */
export function parseDollarInput(raw: string): Result<Cents, InvalidMoneyError> {
  const trimmed = raw.trim().replace(/[$,\s]/g, "");
  if (trimmed.length === 0) {
    return err(new InvalidMoneyError("Enter an amount."));
  }
  const match = trimmed.match(/^([+-]?)(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) {
    return err(new InvalidMoneyError("Use dollars and cents, like 12.34."));
  }
  const sign = match[1] === "-" ? -1 : 1;
  const dollars = Number(match[2]);
  const fraction = match[3] ?? "";
  const centsPart = Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(dollars) || dollars > 100_000_000) {
    return err(new InvalidMoneyError("That amount is too large."));
  }
  return ok(sign * (dollars * 100 + centsPart));
}

export function formatCents(cents: Cents, currency = "USD"): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.trunc(abs / 100);
  const remainder = abs % 100;
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(dollars + remainder / 100);
  if (negative && cents !== 0) {
    return formatted.startsWith("-") ? formatted : `-${formatted}`;
  }
  return formatted;
}

export function expenseMagnitude(signedCents: Cents): Cents {
  return signedCents < 0 ? -signedCents : 0;
}

export function incomeMagnitude(signedCents: Cents): Cents {
  return signedCents > 0 ? signedCents : 0;
}
