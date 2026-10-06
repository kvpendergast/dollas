import { describe, expect, it } from "vitest";
import { BudgetError, InvalidMoneyError } from "../errors";
import { decideBudgetAmount } from "./amount";
import { formatBudgetMonth, parseBudgetMonth, planThroughDate, shiftBudgetMonth } from "./month";
import {
  clearCategoryBudget,
  copyPreviousMonthBudgets,
  listMonthPlan,
  previewCopyPreviousMonth,
  setCategoryBudget,
  UNGROUPED_SECTION_NAME,
} from "./service";
import type { BudgetCategory, BudgetStore, SpendSplit, StoredBudget } from "./store";

type BudgetRow = StoredBudget & { householdId: string; year: number; month: number };
type SpendRow = SpendSplit & { householdId: string; occurredOn: string };

function memoryStore(seed: {
  categories: BudgetCategory[];
  budgets?: BudgetRow[];
  spending?: SpendRow[];
}): BudgetStore & { budgets: BudgetRow[] } {
  const budgets = [...(seed.budgets ?? [])];
  const spending = seed.spending ?? [];
  return {
    budgets,
    async listCategories(householdId) {
      return seed.categories.filter((row) => row.householdId === householdId);
    },
    async findCategory(householdId, categoryId) {
      return seed.categories.find((row) => row.householdId === householdId && row.id === categoryId) ?? null;
    },
    async listBudgets(householdId, month) {
      return budgets
        .filter((row) => row.householdId === householdId && row.year === month.year && row.month === month.month)
        .map((row) => ({ categoryId: row.categoryId, amountCents: row.amountCents }));
    },
    async listSpending(householdId, range) {
      return spending
        .filter((row) => row.householdId === householdId && row.occurredOn >= range.start && row.occurredOn <= range.end)
        .map((row) => ({ categoryId: row.categoryId, kind: row.kind, amountCents: row.amountCents }));
    },
    async upsertBudget(input) {
      const index = budgets.findIndex(
        (row) =>
          row.householdId === input.householdId &&
          row.categoryId === input.categoryId &&
          row.year === input.month.year &&
          row.month === input.month.month,
      );
      const next = {
        householdId: input.householdId,
        categoryId: input.categoryId,
        year: input.month.year,
        month: input.month.month,
        amountCents: input.amountCents,
      };
      if (index >= 0) budgets[index] = next;
      else budgets.push(next);
    },
    async deleteBudget(input) {
      const index = budgets.findIndex(
        (row) =>
          row.householdId === input.householdId &&
          row.categoryId === input.categoryId &&
          row.year === input.month.year &&
          row.month === input.month.month,
      );
      if (index >= 0) budgets.splice(index, 1);
    },
  };
}

function category(overrides: Partial<BudgetCategory> & Pick<BudgetCategory, "id" | "name" | "kind">): BudgetCategory {
  return {
    householdId: "maple",
    sortOrder: 0,
    groupId: null,
    groupName: null,
    groupSort: null,
    ...overrides,
  };
}

const food = {
  groceries: category({
    id: "groceries",
    name: "Groceries",
    kind: "expense",
    sortOrder: 1,
    groupId: "food",
    groupName: "Food",
    groupSort: 0,
  }),
  dining: category({
    id: "dining",
    name: "Dining out",
    kind: "expense",
    sortOrder: 0,
    groupId: "food",
    groupName: "Food",
    groupSort: 0,
  }),
  paycheck: category({
    id: "paycheck",
    name: "Paycheck",
    kind: "income",
    sortOrder: 2,
    groupId: "food",
    groupName: "Food",
    groupSort: 0,
  }),
};

const rent = category({
  id: "rent",
  name: "Rent",
  kind: "expense",
  sortOrder: 0,
  groupId: "housing",
  groupName: "Housing",
  groupSort: 1,
});

const misc = category({ id: "misc", name: "Misc", kind: "expense", sortOrder: 0 });
const transfer = category({ id: "card", name: "Card payment", kind: "transfer", sortOrder: 1 });

describe("decideBudgetAmount", () => {
  it("clears a blank field and saves a typed amount, including zero", () => {
    expect(decideBudgetAmount("")._unsafeUnwrap()).toEqual({ action: "clear" });
    expect(decideBudgetAmount("   ")._unsafeUnwrap()).toEqual({ action: "clear" });
    expect(decideBudgetAmount("0")._unsafeUnwrap()).toEqual({ action: "set", amountCents: 0 });
    expect(decideBudgetAmount("12.34")._unsafeUnwrap()).toEqual({ action: "set", amountCents: 1234 });
  });

  it("rejects a negative budget", () => {
    const result = decideBudgetAmount("-5");
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(InvalidMoneyError);
    expect(result._unsafeUnwrapErr().message).toBe("A budget cannot be negative.");
  });
});

describe("plan months", () => {
  it("parses a month key and steps across the year", () => {
    expect(parseBudgetMonth("2026-01")._unsafeUnwrap()).toEqual({ year: 2026, month: 1 });
    expect(formatBudgetMonth({ year: 2026, month: 9 })).toBe("2026-09");
    expect(shiftBudgetMonth({ year: 2026, month: 1 }, -1)._unsafeUnwrap()).toEqual({ year: 2025, month: 12 });
    expect(shiftBudgetMonth({ year: 2000, month: 1 }, -1).isErr()).toBe(true);
    expect(parseBudgetMonth("2026-13").isErr()).toBe(true);
  });

  it("keeps the current month open through today and other months whole", () => {
    expect(planThroughDate({ year: 2026, month: 10 }, { year: 2026, month: 10, day: 6 })).toEqual({
      year: 2026,
      month: 10,
      day: 6,
    });
    expect(planThroughDate({ year: 2026, month: 9 }, { year: 2026, month: 10, day: 6 })).toEqual({
      year: 2026,
      month: 9,
      day: 30,
    });
  });
});

describe("listMonthPlan", () => {
  const categories = [food.dining, food.groceries, food.paycheck, rent, misc, transfer];
  const store = memoryStore({
    categories: [
      ...categories,
      category({ id: "other-rent", name: "Other rent", kind: "expense", householdId: "other", groupId: "housing" }),
    ],
    budgets: [
      { householdId: "maple", categoryId: "groceries", year: 2026, month: 9, amountCents: 48000 },
      { householdId: "maple", categoryId: "dining", year: 2026, month: 9, amountCents: 36000 },
      { householdId: "maple", categoryId: "groceries", year: 2026, month: 10, amountCents: 50000 },
      { householdId: "other", categoryId: "other-rent", year: 2026, month: 10, amountCents: 90000 },
    ],
    spending: [
      { householdId: "maple", categoryId: "groceries", kind: "expense", amountCents: -12000, occurredOn: "2026-09-30" },
      { householdId: "maple", categoryId: "groceries", kind: "expense", amountCents: -4000, occurredOn: "2026-10-01" },
      { householdId: "maple", categoryId: "dining", kind: "expense", amountCents: -8000, occurredOn: "2026-10-06" },
      { householdId: "maple", categoryId: "dining", kind: "expense", amountCents: -1500, occurredOn: "2026-10-07" },
      { householdId: "maple", categoryId: "paycheck", kind: "income", amountCents: 320000, occurredOn: "2026-10-01" },
      { householdId: "maple", categoryId: "paycheck", kind: "income", amountCents: 10000, occurredOn: "2026-09-15" },
      { householdId: "maple", categoryId: "card", kind: "transfer", amountCents: -5000, occurredOn: "2026-10-03" },
      { householdId: "other", categoryId: "other-rent", kind: "expense", amountCents: -100, occurredOn: "2026-10-02" },
    ],
  });
  const asOf = { year: 2026, month: 10, day: 6 };

  it("switches the month's budgets, spending, and income without leaking another household", async () => {
    const september = (await listMonthPlan(store, { householdId: "maple", month: { year: 2026, month: 9 }, asOf }))._unsafeUnwrap();
    const october = (await listMonthPlan(store, { householdId: "maple", month: { year: 2026, month: 10 }, asOf }))._unsafeUnwrap();

    const septemberGroceries = september.sections
      .flatMap((section) => section.categories)
      .find((row) => row.categoryId === "groceries");
    const octoberGroceries = october.sections
      .flatMap((section) => section.categories)
      .find((row) => row.categoryId === "groceries");
    expect(septemberGroceries).toMatchObject({ budgetCents: 48000, spentCents: 12000 });
    expect(octoberGroceries).toMatchObject({ budgetCents: 50000, spentCents: 4000 });
    expect(september.incomeCents).toBe(10000);
    expect(october.incomeCents).toBe(320000);
    expect(october.sections.flatMap((section) => section.categories).some((row) => row.categoryId === "other-rent")).toBe(
      false,
    );
    const octoberDining = october.sections.flatMap((section) => section.categories).find((row) => row.categoryId === "dining");
    expect(octoberDining?.spentCents).toBe(8000);
  });

  it("sections expense categories by group and leaves income and transfer off the plan", async () => {
    const october = (
      await listMonthPlan(store, { householdId: "maple", month: { year: 2026, month: 10 }, asOf })
    )._unsafeUnwrap();
    expect(october.sections.map((section) => [section.name, section.categories.map((row) => row.name)])).toEqual([
      ["Food", ["Dining out", "Groceries"]],
      ["Housing", ["Rent"]],
      [UNGROUPED_SECTION_NAME, ["Misc"]],
    ]);
    const names = october.sections.flatMap((section) => section.categories.map((row) => row.name));
    expect(names).not.toContain("Paycheck");
    expect(names).not.toContain("Card payment");
  });
});

describe("clearCategoryBudget", () => {
  it("removes the month's budget and leaves a typed zero in place", async () => {
    const store = memoryStore({
      categories: [food.groceries, food.paycheck],
      budgets: [
        { householdId: "maple", categoryId: "groceries", year: 2026, month: 10, amountCents: 48000 },
        { householdId: "other", categoryId: "groceries", year: 2026, month: 10, amountCents: 100 },
      ],
    });
    const cleared = await clearCategoryBudget(store, {
      householdId: "maple",
      categoryId: "groceries",
      month: { year: 2026, month: 10 },
    });
    expect(cleared.isOk()).toBe(true);
    const plan = (
      await listMonthPlan(store, {
        householdId: "maple",
        month: { year: 2026, month: 10 },
        asOf: { year: 2026, month: 10, day: 6 },
      })
    )._unsafeUnwrap();
    expect(plan.sections[0]?.categories[0]).toMatchObject({ categoryId: "groceries", budgetCents: null, standing: "unbudgeted" });
    expect(store.budgets).toEqual([
      { householdId: "other", categoryId: "groceries", year: 2026, month: 10, amountCents: 100 },
    ]);

    const zero = await setCategoryBudget(store, {
      householdId: "maple",
      categoryId: "groceries",
      month: { year: 2026, month: 10 },
      amountCents: 0,
    });
    expect(zero.isOk()).toBe(true);
    expect(store.budgets).toContainEqual({
      householdId: "maple",
      categoryId: "groceries",
      year: 2026,
      month: 10,
      amountCents: 0,
    });
  });

  it("refuses to budget an income category", async () => {
    const store = memoryStore({ categories: [food.paycheck] });
    const result = await setCategoryBudget(store, {
      householdId: "maple",
      categoryId: "paycheck",
      month: { year: 2026, month: 10 },
      amountCents: 100,
    });
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(BudgetError);
    expect(result._unsafeUnwrapErr().message).toBe("Plan budgets are for expense categories.");
    expect(store.budgets).toHaveLength(0);
  });
});

describe("copyPreviousMonthBudgets", () => {
  function storeWithHistory() {
    return memoryStore({
      categories: [food.dining, food.groceries, rent, misc],
      budgets: [
        { householdId: "maple", categoryId: "groceries", year: 2026, month: 9, amountCents: 48000 },
        { householdId: "maple", categoryId: "dining", year: 2026, month: 9, amountCents: 36000 },
        { householdId: "maple", categoryId: "rent", year: 2026, month: 9, amountCents: 180000 },
        { householdId: "maple", categoryId: "groceries", year: 2026, month: 10, amountCents: 50000 },
        { householdId: "maple", categoryId: "rent", year: 2026, month: 10, amountCents: 180000 },
      ],
    });
  }

  it("shows copies and overwrites, then applies copies without clobbering", async () => {
    const store = storeWithHistory();
    const preview = (
      await previewCopyPreviousMonth(store, { householdId: "maple", month: { year: 2026, month: 10 } })
    )._unsafeUnwrap();
    expect(preview.from).toEqual({ year: 2026, month: 9 });
    expect(preview.copies.map((line) => [line.name, line.previousCents, line.currentCents])).toEqual([
      ["Dining out", 36000, null],
    ]);
    expect(preview.overwrites.map((line) => [line.name, line.previousCents, line.currentCents])).toEqual([
      ["Groceries", 48000, 50000],
    ]);
    expect(preview.unchangedCount).toBe(1);

    const applied = (
      await copyPreviousMonthBudgets(store, {
        householdId: "maple",
        month: { year: 2026, month: 10 },
        confirmOverwrite: false,
      })
    )._unsafeUnwrap();
    expect(applied.copied.map((line) => line.categoryId)).toEqual(["dining"]);
    expect(applied.overwritten).toEqual([]);
    expect(store.budgets).toContainEqual({
      householdId: "maple",
      categoryId: "dining",
      year: 2026,
      month: 10,
      amountCents: 36000,
    });
    expect(store.budgets).toContainEqual({
      householdId: "maple",
      categoryId: "groceries",
      year: 2026,
      month: 10,
      amountCents: 50000,
    });
  });

  it("overwrites this month only after confirmation", async () => {
    const onlyOverwrite = memoryStore({
      categories: [food.groceries],
      budgets: [
        { householdId: "maple", categoryId: "groceries", year: 2026, month: 9, amountCents: 48000 },
        { householdId: "maple", categoryId: "groceries", year: 2026, month: 10, amountCents: 50000 },
      ],
    });
    const blocked = await copyPreviousMonthBudgets(onlyOverwrite, {
      householdId: "maple",
      month: { year: 2026, month: 10 },
      confirmOverwrite: false,
    });
    expect(blocked._unsafeUnwrapErr().message).toBe("Confirm overwrite to replace budgets already set this month.");
    expect(onlyOverwrite.budgets.find((row) => row.month === 10)?.amountCents).toBe(50000);

    const confirmed = (
      await copyPreviousMonthBudgets(onlyOverwrite, {
        householdId: "maple",
        month: { year: 2026, month: 10 },
        confirmOverwrite: true,
      })
    )._unsafeUnwrap();
    expect(confirmed.overwritten.map((line) => line.categoryId)).toEqual(["groceries"]);
    expect(onlyOverwrite.budgets.find((row) => row.month === 10)?.amountCents).toBe(48000);
  });

  it("reports when last month has nothing new to copy", async () => {
    const store = memoryStore({
      categories: [food.groceries],
      budgets: [
        { householdId: "maple", categoryId: "groceries", year: 2026, month: 9, amountCents: 48000 },
        { householdId: "maple", categoryId: "groceries", year: 2026, month: 10, amountCents: 48000 },
      ],
    });
    const result = await copyPreviousMonthBudgets(store, {
      householdId: "maple",
      month: { year: 2026, month: 10 },
      confirmOverwrite: true,
    });
    expect(result._unsafeUnwrapErr().message).toBe("This month already matches last month.");
  });
});
