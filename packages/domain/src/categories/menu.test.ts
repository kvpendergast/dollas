import { describe, expect, it } from "vitest";
import { InvalidCategoryError } from "../errors";
import { categoryMenuSections, type CategoryMenuEntry } from "./menu";

function entry(overrides: Partial<CategoryMenuEntry> & Pick<CategoryMenuEntry, "id" | "name" | "kind">): CategoryMenuEntry {
  return {
    sortOrder: 0,
    groupId: "giving",
    groupName: "Giving",
    groupSort: 0,
    ...overrides,
  };
}

describe("categoryMenuSections", () => {
  it("files each category under its own kind inside the household group", () => {
    const result = categoryMenuSections([
      entry({ id: "birthday", name: "Birthday money", kind: "income", sortOrder: 0 }),
      entry({ id: "coffee", name: "Coffee", kind: "expense", sortOrder: 1 }),
      entry({ id: "card", name: "Card payment", kind: "transfer", sortOrder: 2 }),
      entry({
        id: "paycheck",
        name: "Paycheck",
        kind: "income",
        sortOrder: 0,
        groupId: null,
        groupName: null,
        groupSort: null,
      }),
      entry({
        id: "rent",
        name: "Rent",
        kind: "expense",
        sortOrder: 1,
        groupId: null,
        groupName: null,
        groupSort: null,
      }),
    ]);
    const sections = result._unsafeUnwrap();
    expect(sections.map((section) => section.label)).toEqual([
      "Giving · Income",
      "Giving · Expense",
      "Giving · Transfer",
      "Ungrouped · Income",
      "Ungrouped · Expense",
    ]);
    expect(sections.find((section) => section.label === "Giving · Expense")?.items.map((item) => item.name)).toEqual([
      "Coffee",
    ]);
    expect(sections.find((section) => section.label === "Giving · Transfer")?.items.map((item) => item.name)).toEqual([
      "Card payment",
    ]);
    expect(sections.find((section) => section.label === "Giving · Income")?.items.map((item) => item.name)).toEqual([
      "Birthday money",
    ]);
  });

  it("does not put later categories under the kind of the first one in the group", () => {
    const result = categoryMenuSections([
      entry({ id: "coffee", name: "Coffee", kind: "expense", sortOrder: 0 }),
      entry({ id: "card", name: "Card payment", kind: "transfer", sortOrder: 1 }),
      entry({ id: "birthday", name: "Birthday money", kind: "income", sortOrder: 2 }),
    ]);
    const sections = result._unsafeUnwrap();
    expect(sections.map((section) => [section.kind, section.items.map((item) => item.name)])).toEqual([
      ["income", ["Birthday money"]],
      ["expense", ["Coffee"]],
      ["transfer", ["Card payment"]],
    ]);
  });

  it("rejects an unknown kind", () => {
    const result = categoryMenuSections([entry({ id: "x", name: "Mystery", kind: "savings" })]);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(InvalidCategoryError);
  });
});
