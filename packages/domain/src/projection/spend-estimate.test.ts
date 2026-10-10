import { describe, expect, it } from "vitest";
import type { StatusLink } from "../recurring/status";
import { buildSpendEstimate, type EstimateRecurringItem, type EstimateSplit } from "./spend-estimate";

const categories = [
  { id: "groceries", name: "Groceries", kind: "expense" },
  { id: "dining", name: "Dining", kind: "expense" },
  { id: "rent", name: "Rent", kind: "expense" },
  { id: "pay", name: "Paycheck", kind: "income" },
  { id: "move", name: "Transfers", kind: "transfer" },
];

const split = (occurredOn: string, categoryId: string, amountCents: number, recurring = false): EstimateSplit => ({
  occurredOn,
  categoryId,
  kind: categories.find((row) => row.id === categoryId)?.kind ?? "expense",
  amountCents,
  recurring,
});

/** $30 of groceries every day from `from` to `to`. */
function daily(from: string, to: string, cents = -3000, categoryId = "groceries"): EstimateSplit[] {
  const out: EstimateSplit[] = [];
  for (let d = Date.parse(`${from}T00:00:00Z`); d <= Date.parse(`${to}T00:00:00Z`); d += 86_400_000) {
    out.push(split(new Date(d).toISOString().slice(0, 10), categoryId, cents));
  }
  return out;
}

const rent: EstimateRecurringItem = {
  id: "rent-item",
  name: "Rent",
  amountCents: -150000,
  windowDays: 3,
  paused: false,
  cadence: "monthly",
  anchorDate: "2026-01-01",
  dayOfMonth: null,
  secondDayOfMonth: null,
  startDate: null,
  endDate: null,
  categoryId: "rent",
};
const pay: EstimateRecurringItem = { ...rent, id: "pay-item", name: "Paycheck", amountCents: 250000, anchorDate: "2026-01-15", categoryId: "pay" };
const link = (itemId: string, occurrenceDate: string, amountCents: number): StatusLink => ({
  itemId,
  occurrenceDate,
  transactionId: `${itemId}-${occurrenceDate}`,
  occurredOn: occurrenceDate,
  payee: itemId,
  amountCents,
  deleted: false,
});

const base = {
  categories,
  recurringItems: [] as EstimateRecurringItem[],
  recurringLinks: [] as StatusLink[],
  budgetCents: { thisMonth: null, nextMonth: null },
};

describe("buildSpendEstimate", () => {
  it("mid month: blends this month's pace with the 90 days before, weighted by day of month", () => {
    // 90 days before October at $30/day; October so far at $60/day for 10 days.
    const result = buildSpendEstimate({
      ...base,
      today: "2026-10-10",
      firstTransactionOn: "2026-01-01",
      splits: [...daily("2026-07-03", "2026-09-30"), ...daily("2026-10-01", "2026-10-10", -6000)],
    })._unsafeUnwrap();
    expect(result.kind).toBe("estimate");
    expect(result.pace).toMatchObject({
      basis: "blended",
      trailingDays: 90,
      trailingDailyCents: 3000,
      thisMonthDays: 10,
      thisMonthDailyCents: 6000,
      thisMonthWeightPercent: 32,
    });
    // 10/31 × 6000 + 21/31 × 3000 = 3967.74… → 3968 a day.
    expect(result.pace.dailyCents).toBe(3968);
    expect(result.thisMonth).toMatchObject({ spentSoFarCents: 60000, paceDays: 21, paceCents: 3968 * 21, estimateCents: 60000 + 3968 * 21 });
    expect(result.nextMonth).toMatchObject({ month: "2026-11", daysInMonth: 30, paceDays: 30, spentSoFarCents: 0, estimateCents: 3968 * 30 });
  });

  it("early month: the steadier 90-day pace dominates a big first day", () => {
    const result = buildSpendEstimate({
      ...base,
      today: "2026-10-01",
      firstTransactionOn: "2026-01-01",
      splits: [...daily("2026-07-03", "2026-09-30"), split("2026-10-01", "groceries", -50000)],
    })._unsafeUnwrap();
    // 1/31 × 50000 + 30/31 × 3000 = 4516.13 → 4516, not $500 a day.
    expect(result.pace.dailyCents).toBe(4516);
    expect(result.thisMonth.estimateCents).toBe(50000 + 4516 * 30);
  });

  it("last day: nothing left to pace, so the estimate is spent so far plus bills still due", () => {
    const result = buildSpendEstimate({
      ...base,
      today: "2026-10-31",
      firstTransactionOn: "2026-01-01",
      splits: daily("2026-07-03", "2026-10-31"),
      recurringItems: [{ ...rent, anchorDate: "2026-01-31" }],
    })._unsafeUnwrap();
    expect(result.pace.thisMonthWeightPercent).toBe(100);
    expect(result.thisMonth.paceDays).toBe(0);
    expect(result.thisMonth.paceCents).toBe(0);
    expect(result.thisMonth.recurringExpectedCents).toBe(150000);
    expect(result.thisMonth.estimateCents).toBe(31 * 3000 + 150000);
    expect(result.nextMonth.month).toBe("2026-11");
  });

  it("rolls December into January", () => {
    const result = buildSpendEstimate({ ...base, today: "2026-12-20", firstTransactionOn: null, splits: [] })._unsafeUnwrap();
    expect(result.nextMonth).toMatchObject({ month: "2027-01", daysInMonth: 31 });
  });

  it("no history: says so and shows recurring only", () => {
    const result = buildSpendEstimate({
      ...base,
      today: "2026-10-10",
      firstTransactionOn: "2026-10-05",
      splits: daily("2026-10-05", "2026-10-10"),
      recurringItems: [rent],
    })._unsafeUnwrap();
    expect(result.pace.basis).toBe("not_enough_history");
    expect(result.pace.dailyCents).toBe(0);
    expect(result.thisMonth.spentSoFarCents).toBe(6 * 3000);
    expect(result.nextMonth.estimateCents).toBe(150000);
    const empty = buildSpendEstimate({ ...base, today: "2026-10-10", firstTransactionOn: null, splits: [] })._unsafeUnwrap();
    expect(empty.pace.basis).toBe("not_enough_history");
    expect(empty.thisMonth.estimateCents).toBe(0);
    expect(empty.categories).toEqual([]);
  });

  it("short history: pools every observed day instead of blending", () => {
    // Started Sept 25: 6 days before October plus 10 in October = 16 days at $30.
    const result = buildSpendEstimate({
      ...base,
      today: "2026-10-10",
      firstTransactionOn: "2026-09-25",
      splits: [...daily("2026-09-25", "2026-09-30"), ...daily("2026-10-01", "2026-10-10", -4600)],
    })._unsafeUnwrap();
    expect(result.pace).toMatchObject({ basis: "pooled", trailingDays: 6, thisMonthDays: 10, thisMonthWeightPercent: null });
    // (6 × 3000 + 10 × 4600) / 16 = 4000.
    expect(result.pace.dailyCents).toBe(4000);
  });

  it("recurring: paid counts in spent so far, expected adds, missed is left out", () => {
    const water: EstimateRecurringItem = { ...rent, id: "water", name: "Water", amountCents: -5000, anchorDate: "2026-01-05", categoryId: "groceries" };
    const phone: EstimateRecurringItem = { ...rent, id: "phone", name: "Phone", amountCents: -7000, anchorDate: "2026-01-20", categoryId: null };
    const result = buildSpendEstimate({
      ...base,
      today: "2026-10-10",
      firstTransactionOn: "2026-01-01",
      splits: [split("2026-10-01", "rent", -150000, true), ...daily("2026-07-03", "2026-10-10", -1000, "dining")],
      // Rent paid Oct 1; water (Oct 5) missed (window closed Oct 8); phone (Oct 20) upcoming; paycheck Oct 15 expected.
      recurringItems: [rent, water, phone, pay],
      recurringLinks: [link("rent-item", "2026-10-01", -150000)],
    })._unsafeUnwrap();
    expect(result.thisMonth.recurringPaidCents).toBe(150000);
    expect(result.thisMonth.recurringMissedCents).toBe(5000);
    expect(result.thisMonth.recurringExpectedCents).toBe(7000);
    expect(result.pace.dailyCents).toBe(1000);
    expect(result.thisMonth.spentSoFarCents).toBe(150000 + 10 * 1000);
    expect(result.thisMonth.estimateCents).toBe(150000 + 10_000 + 7000 + 21 * 1000);
    expect(result.thisMonth.recurringIncomeExpectedCents).toBe(250000);
    expect(result.thisMonth.moneyLeftCents).toBe(250000 - result.thisMonth.estimateCents);
    // Next month: rent, water, phone all expected.
    expect(result.nextMonth.recurringExpectedCents).toBe(150000 + 5000 + 7000);
    expect(result.nextMonth.recurringIncomeExpectedCents).toBe(250000);
    const phoneLine = result.categories.find((line) => line.categoryId === null);
    expect(phoneLine).toMatchObject({ name: "Recurring, no category", thisMonth: { recurringCents: 7000 }, nextMonth: { recurringCents: 7000 } });
  });

  it("leaves transactions linked to recurring items, income, and transfers out of the pace", () => {
    const result = buildSpendEstimate({
      ...base,
      today: "2026-10-10",
      firstTransactionOn: "2026-01-01",
      splits: [
        ...daily("2026-07-03", "2026-10-10", -2000),
        split("2026-08-01", "rent", -150000, true),
        split("2026-09-01", "rent", -150000, true),
        split("2026-10-01", "rent", -150000, true),
        split("2026-10-02", "pay", 250000),
        split("2026-09-15", "move", -90000),
        split("2026-10-03", "move", -90000),
      ],
    })._unsafeUnwrap();
    expect(result.pace.dailyCents).toBe(2000);
    expect(result.pace.trailingCents).toBe(90 * 2000);
    expect(result.thisMonth.spentSoFarCents).toBe(10 * 2000 + 150000);
    expect(result.thisMonth.incomeSoFarCents).toBe(250000);
  });

  it("breaks the estimate down by category, and the categories add up", () => {
    const result = buildSpendEstimate({
      ...base,
      today: "2026-10-10",
      firstTransactionOn: "2026-01-01",
      splits: [...daily("2026-07-03", "2026-10-10", -2000), ...daily("2026-07-03", "2026-10-10", -1000, "dining"), split("2026-10-01", "rent", -150000, true)],
      recurringItems: [rent],
      recurringLinks: [link("rent-item", "2026-10-01", -150000)],
      budgetCents: { thisMonth: 300000, nextMonth: null },
    })._unsafeUnwrap();
    expect(result.categories.map((line) => [line.name, line.thisMonth.estimateCents, line.nextMonth.estimateCents])).toEqual([
      ["Rent", 150000, 150000],
      ["Groceries", 31 * 2000, 30 * 2000],
      ["Dining", 31 * 1000, 30 * 1000],
    ]);
    const total = result.categories.reduce((sum, line) => sum + line.thisMonth.estimateCents, 0);
    expect(total).toBe(result.thisMonth.estimateCents);
    expect(result.nextMonth.estimateCents).toBe(result.categories.reduce((sum, line) => sum + line.nextMonth.estimateCents, 0));
    expect(result.thisMonth.underBudgetCents).toBe(300000 - result.thisMonth.estimateCents);
    expect(result.nextMonth.underBudgetCents).toBeNull();
    expect(result.nextMonth.moneyLeftCents).toBeNull();
  });

  it("refuses a bad date", () => {
    expect(buildSpendEstimate({ ...base, today: "2026-02-30", firstTransactionOn: null, splits: [] }).isErr()).toBe(true);
  });
});
