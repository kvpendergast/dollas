import { describe, expect, it } from "vitest";
import { expectedRecurringAmounts, itemOccurrences, nextExpectedDate, occurrenceStatus, type StatusItem, type StatusLink } from "./status";

const rent: StatusItem = {
  id: "rent",
  name: "Rent",
  amountCents: -150000,
  windowDays: 3,
  paused: false,
  cadence: "monthly",
  anchorDate: "2026-01-01",
  dayOfMonth: null,
  secondDayOfMonth: null,
  startDate: "2026-01-01",
  endDate: null,
};
const pay: StatusItem = { ...rent, id: "pay", name: "Paycheck", amountCents: 250000, cadence: "semimonthly", anchorDate: "2026-01-15", secondDayOfMonth: 31 };
const link = (itemId: string, occurrenceDate: string, amountCents: number, deleted = false): StatusLink => ({
  itemId,
  occurrenceDate,
  transactionId: `${itemId}-${occurrenceDate}`,
  occurredOn: occurrenceDate,
  payee: itemId,
  amountCents,
  deleted,
});

describe("recurring occurrence status", () => {
  it("labels paid, received, missed, expected, upcoming", () => {
    expect(occurrenceStatus(rent, "2026-10-01", true, "2026-10-10")).toBe("paid");
    expect(occurrenceStatus(pay, "2026-10-01", true, "2026-10-10")).toBe("received");
    expect(occurrenceStatus(rent, "2026-10-01", false, "2026-10-05")).toBe("missed");
    expect(occurrenceStatus(rent, "2026-10-01", false, "2026-10-04")).toBe("expected");
    expect(occurrenceStatus(rent, "2026-10-08", false, "2026-10-05")).toBe("expected");
    expect(occurrenceStatus(rent, "2026-10-09", false, "2026-10-05")).toBe("upcoming");
  });

  it("ignores links to soft-deleted transactions and hides a paused item's unpaid dates", () => {
    const rows = itemOccurrences(rent, [link("rent", "2026-09-01", -150000, true)], "2026-09-01", "2026-10-31", "2026-10-10");
    expect(rows.map((row) => row.status)).toEqual(["missed", "missed"]);
    const paused = itemOccurrences({ ...rent, paused: true }, [link("rent", "2026-09-01", -150000)], "2026-09-01", "2026-11-30", "2026-10-10");
    expect(paused.map((row) => `${row.date}:${row.status}`)).toEqual(["2026-09-01:paid"]);
    expect(nextExpectedDate({ ...rent, paused: true }, [], "2026-10-10")).toBeNull();
  });

  it("finds the next unpaid date", () => {
    expect(nextExpectedDate(rent, [], "2026-10-10")).toBe("2026-11-01");
    expect(nextExpectedDate(rent, [], "2026-10-03")).toBe("2026-10-01");
    expect(nextExpectedDate(rent, [link("rent", "2026-10-01", -150000)], "2026-10-03")).toBe("2026-11-01");
  });

  it("splits a range into paid, still expected, and missed", () => {
    const result = expectedRecurringAmounts({
      items: [rent, pay],
      links: [link("rent", "2026-10-01", -149500), link("pay", "2026-10-15", 250000)],
      from: "2026-10-01",
      to: "2026-10-31",
      today: "2026-10-20",
    });
    expect(result.paid).toEqual({ incomeCents: 250000, expenseCents: 149500, count: 2 });
    expect(result.expected).toEqual({ incomeCents: 250000, expenseCents: 0, count: 1 });
    expect(result.missed).toEqual({ incomeCents: 0, expenseCents: 0, count: 0 });
    expect(result.occurrences.map((row) => `${row.itemId}:${row.date}:${row.status}`)).toEqual([
      "rent:2026-10-01:paid",
      "pay:2026-10-15:received",
      "pay:2026-10-31:upcoming",
    ]);
    const late = expectedRecurringAmounts({ items: [rent], links: [], from: "2026-10-01", to: "2026-11-30", today: "2026-10-20" });
    expect(late.missed.expenseCents).toBe(150000);
    expect(late.expected.expenseCents).toBe(150000);
  });
});
