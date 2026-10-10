import { describe, expect, it } from "vitest";
import { budgetStanding } from "./budget-status";

describe("budgetStanding", () => {
  it("flags spend past the monthly budget", () => {
    expect(budgetStanding(8_000, 5_000)).toBe("over");
    expect(budgetStanding(5_000, 5_000)).toBe("within");
    expect(budgetStanding(100, null)).toBe("unbudgeted");
  });
});

describe("planSoFar", () => {
  it("shows every budgeted category, including $0 spent, and spending outside the plan", async () => {
    const { planSoFar } = await import("./budget-status");
    const plan = planSoFar({
      spent: [
        { categoryId: "groceries", name: "Groceries", spentCents: 60000 },
        { categoryId: "coffee", name: "Coffee", spentCents: 1200 },
        { categoryId: "rent", name: "Rent", spentCents: 186300 },
      ],
      budgets: [
        { categoryId: "groceries", name: "Groceries", budgetCents: 50000 },
        { categoryId: "rent", name: "Rent", budgetCents: 180000 },
        { categoryId: "gifts", name: "Gifts", budgetCents: 10000 },
      ],
    });
    expect(plan.hasBudget).toBe(true);
    expect(plan.budgetedCents).toBe(240000);
    expect(plan.spentInPlanCents).toBe(246300);
    expect(plan.budgeted.map((row) => [row.name, row.spentCents, row.budgetCents, row.standing])).toEqual([
      ["Rent", 186300, 180000, "over"],
      ["Groceries", 60000, 50000, "over"],
      ["Gifts", 0, 10000, "within"],
    ]);
    expect(plan.unbudgeted.map((row) => [row.name, row.spentCents, row.budgetCents])).toEqual([["Coffee", 1200, null]]);
  });

  it("with no budget it is spending by category", async () => {
    const { planSoFar } = await import("./budget-status");
    const plan = planSoFar({ spent: [{ categoryId: "a", name: "A", spentCents: 5 }], budgets: [] });
    expect(plan).toMatchObject({ hasBudget: false, budgetedCents: 0, budgeted: [] });
    expect(plan.unbudgeted).toHaveLength(1);
  });
});
