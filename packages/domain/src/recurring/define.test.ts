import { describe, expect, it } from "vitest";
import { defineRecurringItem } from "./define";

const base = { name: "Rent", amountCents: -150000, cadence: "monthly", anchorDate: "2026-10-01" };

describe("defineRecurringItem", () => {
  it("fills defaults: payee match from the name, 5% and ±3 days, start at the anchor", () => {
    const defined = defineRecurringItem(base)._unsafeUnwrap();
    expect(defined).toMatchObject({
      name: "Rent",
      payeeMatch: "Rent",
      tolerancePercent: 5,
      toleranceCents: 0,
      windowDays: 3,
      startDate: "2026-10-01",
      endDate: null,
      dayOfMonth: null,
    });
  });

  it("refuses bad input with member-safe messages", () => {
    expect(defineRecurringItem({ ...base, name: " " })._unsafeUnwrapErr().message).toBe("Enter a name.");
    expect(defineRecurringItem({ ...base, amountCents: 0 })._unsafeUnwrapErr().message).toBe("Enter an amount greater than zero.");
    expect(defineRecurringItem({ ...base, amountCents: 1.5 }).isErr()).toBe(true);
    expect(defineRecurringItem({ ...base, cadence: "daily" })._unsafeUnwrapErr().message).toBe("Choose how often it repeats.");
    expect(defineRecurringItem({ ...base, anchorDate: "2026-02-30" }).isErr()).toBe(true);
    expect(defineRecurringItem({ ...base, cadence: "semimonthly" })._unsafeUnwrapErr().message).toBe("Choose the second day of the month.");
    expect(defineRecurringItem({ ...base, cadence: "semimonthly", secondDayOfMonth: 1 })._unsafeUnwrapErr().message).toBe(
      "Twice a month needs two different days.",
    );
    expect(defineRecurringItem({ ...base, windowDays: 11 }).isErr()).toBe(true);
    expect(defineRecurringItem({ ...base, tolerancePercent: 51 }).isErr()).toBe(true);
    expect(defineRecurringItem({ ...base, endDate: "2026-09-30" })._unsafeUnwrapErr().message).toBe(
      "The end date must be on or after the start date.",
    );
  });

  it("drops month days on weekly cadences", () => {
    const defined = defineRecurringItem({ ...base, cadence: "weekly", dayOfMonth: 31, secondDayOfMonth: 2 })._unsafeUnwrap();
    expect(defined.dayOfMonth).toBeNull();
    expect(defined.secondDayOfMonth).toBeNull();
  });
});
