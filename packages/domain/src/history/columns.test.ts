import { describe, expect, it } from "vitest";
import { buildSpendingHistory, isPartialMonth } from "./columns";

const asOf = { year: 2026, month: 10, day: 4 };

const expenses = [
  { occurredOn: "2026-10-01", spentCents: 10_000 },
  { occurredOn: "2026-10-04", spentCents: 5_000 },
  { occurredOn: "2026-10-18", spentCents: 90_000 },
  { occurredOn: "2025-10-02", spentCents: 40_000 },
  { occurredOn: "2025-10-20", spentCents: 40_000 },
  { occurredOn: "2026-09-01", spentCents: 20_000 },
  { occurredOn: "2026-09-04", spentCents: 20_000 },
  { occurredOn: "2026-09-21", spentCents: 15_000 },
  { occurredOn: "2025-09-15", spentCents: 30_000 },
  { occurredOn: "2026-08-12", spentCents: 22_000 },
  { occurredOn: "2025-08-12", spentCents: 28_000 },
];

function history() {
  return buildSpendingHistory({ expenses, asOf, monthCount: 3 })._unsafeUnwrap();
}

describe("partial-month history", () => {
  it("marks only the current month as partial", () => {
    expect(isPartialMonth({ year: 2026, month: 10 }, asOf)).toBe(true);
    expect(isPartialMonth({ year: 2026, month: 9 }, asOf)).toBe(false);
    const columns = history();
    const october = columns.find((column) => column.month === 10 && column.year === 2026);
    const september = columns.find((column) => column.month === 9 && column.year === 2026);
    expect(october?.partial).toBe(true);
    expect(october?.partialLabel).toBe("so far");
    expect(september?.partial).toBe(false);
    expect(september?.partialLabel).toBeNull();
  });

  it("does not treat the current month as finished when summing spend", () => {
    const october = history().find((column) => column.year === 2026 && column.month === 10);
    expect(october?.spentCents).toBe(15_000);
  });

  it("says year-over-year is not comparable yet and omits any dollar delta", () => {
    const october = history().find((column) => column.year === 2026 && column.month === 10);
    expect(october?.yearOverYear).toEqual({
      comparable: false,
      label: "Not comparable yet",
    });
    expect(october?.yearOverYear).not.toHaveProperty("deltaCents");
    expect(JSON.stringify(october?.yearOverYear)).not.toMatch(/\$|cent|80000|15000|delta/i);
  });

  it("compares a finished month with the same month last year", () => {
    const september = history().find((column) => column.year === 2026 && column.month === 9);
    expect(september?.spentCents).toBe(55_000);
    expect(september?.priorYearSpentCents).toBe(30_000);
    expect(september?.yearOverYear).toEqual({
      comparable: true,
      deltaCents: 25_000,
      direction: "more",
    });
  });

  it("paints a drop in spending as less and a rise as more", () => {
    const august = buildSpendingHistory({ expenses, asOf, monthCount: 3 })
      ._unsafeUnwrap()
      .find((column) => column.year === 2026 && column.month === 8);
    expect(august?.yearOverYear).toEqual({
      comparable: true,
      deltaCents: -6_000,
      direction: "less",
    });
  });

  it("compares the partial month only with the same elapsed days last month", () => {
    const october = history().find((column) => column.year === 2026 && column.month === 10);
    expect(october?.monthOverMonth).toEqual({
      deltaCents: 15_000 - 40_000,
      direction: "less",
    });
  });

  it("sums the books it is given instead of using a fixed sample", () => {
    const shifted = buildSpendingHistory({
      expenses: [{ occurredOn: "2026-08-02", spentCents: 1234 }],
      asOf,
      monthCount: 3,
    })._unsafeUnwrap();
    const august = shifted.find((column) => column.month === 8);
    expect(august?.spentCents).toBe(1234);
    expect(august?.yearOverYear).toMatchObject({ comparable: true, deltaCents: 1234, direction: "more" });
  });
});
