import { describe, expect, it } from "vitest";
import { InvalidCategoryError } from "../errors";
import { buildSpendingHistory } from "../history/columns";
import { definePayeeCategoryRule, matchingPayeeRule } from "../rules/payee-category";
import { categoryBooksEffect } from "./define";
import { categoryKindChangeWarning, changeCategoryKind } from "./kind";
import { categoryMenuSections, type CategoryMenuEntry } from "./menu";
import type { CategoryCatalog, OrganizedCategory, OrganizedGroup } from "./organize";

const house = "maple";
const other = "oak";

function group(id: string, householdId: string, name: string, sortOrder: number): OrganizedGroup {
  return { id, householdId, name, sortOrder };
}

function category(
  id: string,
  householdId: string,
  groupId: string | null,
  name: string,
  sortOrder: number,
  kind = "expense",
): OrganizedCategory {
  return { id, householdId, groupId, name, kind, sortOrder };
}

function catalog(): CategoryCatalog {
  return {
    groups: [
      group("home", house, "Shelter", 0),
      group("bills", other, "Bills", 0),
    ],
    categories: [
      category("rent", house, "home", "Rent", 0),
      category("groceries", house, "home", "Groceries", 1),
      category("paycheck", house, "home", "Paycheck", 2, "income"),
      category("card", house, "home", "Card payment", 3, "transfer"),
      category("secret", other, "bills", "Secret", 0),
    ],
  };
}

function slice(rows: CategoryCatalog, householdId: string) {
  return {
    groups: rows.groups.filter((row) => row.householdId === householdId),
    categories: rows.categories.filter((row) => row.householdId === householdId),
  };
}

function booksTotals(lines: readonly { kind: string; amountCents: number }[]) {
  return lines.reduce(
    (totals, line) => {
      const effect = categoryBooksEffect(line.kind, line.amountCents)._unsafeUnwrap();
      return {
        incomeCents: totals.incomeCents + effect.incomeCents,
        spentCents: totals.spentCents + effect.spentCents,
      };
    },
    { incomeCents: 0, spentCents: 0 },
  );
}

function spentLines(kind: string, rows: readonly { occurredOn: string; amountCents: number }[]) {
  return rows.flatMap((row) => {
    const spentCents = categoryBooksEffect(kind, row.amountCents)._unsafeUnwrap().spentCents;
    return spentCents === 0 ? [] : [{ occurredOn: row.occurredOn, spentCents }];
  });
}

function menu(rows: CategoryCatalog): CategoryMenuEntry[] {
  return slice(rows, house).categories.map((row) => {
    const owner = rows.groups.find((item) => item.id === row.groupId);
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      sortOrder: row.sortOrder,
      groupId: row.groupId,
      groupName: owner?.name ?? null,
      groupSort: owner?.sortOrder ?? null,
    };
  });
}

describe("categoryKindChangeWarning", () => {
  it("warns that a budgeted expense leaves Plan and its budgets are removed", () => {
    expect(
      categoryKindChangeWarning({
        name: "Groceries",
        currentKind: "expense",
        nextKind: "transfer",
        budgetCount: 15,
      }),
    ).toBe("Changing Groceries from Expense to Transfer moves it off Plan. Its budgets will be removed.");
  });

  it("stays quiet when there is nothing to remove or the category stays on Plan", () => {
    expect(
      categoryKindChangeWarning({ name: "Groceries", currentKind: "expense", nextKind: "income", budgetCount: 0 }),
    ).toBeNull();
    expect(
      categoryKindChangeWarning({ name: "Paycheck", currentKind: "income", nextKind: "expense", budgetCount: 3 }),
    ).toBeNull();
    expect(
      categoryKindChangeWarning({ name: "Groceries", currentKind: "expense", nextKind: "expense", budgetCount: 3 }),
    ).toBeNull();
  });
});

describe("changeCategoryKind", () => {
  it("changes the kind and leaves the rest of the category in place", () => {
    const before = catalog();
    const next = changeCategoryKind(before, house, "groceries", "transfer", 0, false)._unsafeUnwrap();
    const groceries = next.catalog.categories.find((row) => row.id === "groceries");
    expect(groceries).toEqual({
      id: "groceries",
      householdId: house,
      groupId: "home",
      name: "Groceries",
      kind: "transfer",
      sortOrder: 1,
    });
    expect(next.removeBudgetsFor).toBeNull();
    expect(next.catalog.groups).toBe(before.groups);
    expect(before.categories.find((row) => row.id === "groceries")?.kind).toBe("expense");
  });

  it("refuses to save a budgeted kind change until the member confirms removal", () => {
    const before = catalog();
    const snapshot = structuredClone(before);
    const result = changeCategoryKind(before, house, "groceries", "income", 15, false);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(InvalidCategoryError);
    expect(result._unsafeUnwrapErr().message).toBe(
      "Changing Groceries from Expense to Income moves it off Plan. Its budgets will be removed.",
    );
    expect(before).toEqual(snapshot);
  });

  it("removes budgets once the member confirms the category leaves Plan", () => {
    const next = changeCategoryKind(catalog(), house, "rent", "transfer", 15, true)._unsafeUnwrap();
    expect(next.catalog.categories.find((row) => row.id === "rent")?.kind).toBe("transfer");
    expect(next.removeBudgetsFor).toBe("rent");
    const stillOnPlan = next.catalog.categories
      .filter((row) => row.householdId === house && row.kind === "expense")
      .map((row) => row.name);
    expect(stillOnPlan).toEqual(["Groceries"]);
  });

  it("keeps budgets when the category becomes an expense", () => {
    const next = changeCategoryKind(catalog(), house, "paycheck", "expense", 2, false)._unsafeUnwrap();
    expect(next.catalog.categories.find((row) => row.id === "paycheck")?.kind).toBe("expense");
    expect(next.removeBudgetsFor).toBeNull();
  });

  it("leaves a category alone when the kind does not change", () => {
    const before = catalog();
    const next = changeCategoryKind(before, house, "groceries", "expense", 15, false)._unsafeUnwrap();
    expect(next.catalog).toBe(before);
    expect(next.removeBudgetsFor).toBeNull();
  });

  it("does not change another household's category", () => {
    const before = catalog();
    const snapshot = structuredClone(before);
    const result = changeCategoryKind(before, house, "secret", "transfer", 4, true);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toBe("Choose a category in this household.");
    expect(before).toEqual(snapshot);

    const next = changeCategoryKind(before, house, "groceries", "transfer", 3, true)._unsafeUnwrap();
    expect(slice(next.catalog, other)).toEqual(slice(before, other));
    expect(next.removeBudgetsFor).toBe("groceries");
  });

  it("rejects an unknown kind and a budget count that is not a whole number", () => {
    const unknown = changeCategoryKind(catalog(), house, "groceries", "savings", 0, false);
    expect(unknown._unsafeUnwrapErr()).toBeInstanceOf(InvalidCategoryError);
    const counted = changeCategoryKind(catalog(), house, "groceries", "transfer", 1.5, true);
    expect(counted._unsafeUnwrapErr().message).toBe("Budget count is not valid.");
  });

  it("moves the category to its new Activity section", () => {
    const next = changeCategoryKind(catalog(), house, "groceries", "transfer", 0, false)._unsafeUnwrap();
    const sections = categoryMenuSections(menu(next.catalog))._unsafeUnwrap();
    const transfer = sections.find((section) => section.kind === "transfer");
    const expense = sections.find((section) => section.kind === "expense");
    expect(transfer?.label).toBe("Shelter · Transfer");
    expect(transfer?.items.map((item) => item.name)).toEqual(["Groceries", "Card payment"]);
    expect(expense?.items.map((item) => item.name)).toEqual(["Rent"]);
  });

  it("keeps a payee rule pointed at the category after the kind changes", () => {
    const rule = definePayeeCategoryRule({ pattern: "Corner Market", categoryId: "groceries" })._unsafeUnwrap();
    const next = changeCategoryKind(catalog(), house, "groceries", "transfer", 0, false)._unsafeUnwrap();
    expect(matchingPayeeRule("Corner Market #4", [rule])?.categoryId).toBe("groceries");
    expect(next.catalog.categories.find((row) => row.id === "groceries")?.kind).toBe("transfer");
  });

  it("drops a transfer out of income and spending totals, including history", () => {
    const lines = [
      { id: "paycheck", kind: "income", amountCents: 320_000 },
      { id: "groceries", kind: "expense", amountCents: -64_000 },
      { id: "groceries", kind: "expense", amountCents: -12_000 },
    ];
    expect(booksTotals(lines)).toEqual({ incomeCents: 320_000, spentCents: 76_000 });

    const next = changeCategoryKind(catalog(), house, "groceries", "transfer", 2, true)._unsafeUnwrap();
    const kindOf = new Map(next.catalog.categories.map((row) => [row.id, row.kind]));
    const retold = lines.map((line) => ({ ...line, kind: kindOf.get(line.id) ?? line.kind }));
    expect(booksTotals(retold)).toEqual({ incomeCents: 320_000, spentCents: 0 });

    const dated = [{ occurredOn: "2026-10-02", amountCents: -64_000 }];
    const asOf = { year: 2026, month: 10, day: 5 };
    const beforeHistory = buildSpendingHistory({
      expenses: spentLines("expense", dated),
      asOf,
      monthCount: 1,
    })._unsafeUnwrap();
    const afterHistory = buildSpendingHistory({
      expenses: spentLines("transfer", dated),
      asOf,
      monthCount: 1,
    })._unsafeUnwrap();
    expect(beforeHistory[0]?.spentCents).toBe(64_000);
    expect(afterHistory[0]?.spentCents).toBe(0);
  });
});
