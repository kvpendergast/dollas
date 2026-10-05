import { describe, expect, it } from "vitest";
import { InvalidCategoryError } from "../errors";
import { categoryMenuSections, type CategoryMenuEntry } from "./menu";
import {
  moveCategory,
  removeCategoryGroup,
  renameCategoryGroup,
  reorderCategories,
  reorderGroups,
  shiftCategory,
  shiftGroup,
  type CategoryCatalog,
  type OrganizedCategory,
  type OrganizedGroup,
} from "./organize";

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
      group("home", house, "Home", 0),
      group("fun", house, "Fun", 1),
      group("bills", other, "Bills", 0),
    ],
    categories: [
      category("rent", house, "home", "Rent", 0),
      category("groceries", house, "home", "Groceries", 1),
      category("gift", house, "fun", "Gift", 0, "income"),
      category("dining", house, "fun", "Dining out", 1),
      category("card", house, "fun", "Card payment", 2, "transfer"),
      category("paycheck", house, null, "Paycheck", 0, "income"),
      category("secret", other, "bills", "Secret", 3),
    ],
  };
}

function slice(rows: CategoryCatalog, householdId: string) {
  return {
    groups: rows.groups.filter((row) => row.householdId === householdId),
    categories: rows.categories.filter((row) => row.householdId === householdId),
  };
}

function expectIsolated(before: CategoryCatalog, after: CategoryCatalog) {
  expect(slice(after, other)).toEqual(slice(before, other));
}

function expectUnchanged(before: CategoryCatalog) {
  const snapshot = structuredClone(before);
  return {
    snapshot,
    check(result: { isErr(): boolean }) {
      expect(result.isErr()).toBe(true);
      expect(before).toEqual(snapshot);
    },
  };
}

function menuEntries(rows: CategoryCatalog): CategoryMenuEntry[] {
  return slice(rows, house).categories.map((row) => {
    const owner = row.groupId ? rows.groups.find((item) => item.id === row.groupId) : undefined;
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

function labels(rows: CategoryCatalog): string[] {
  return categoryMenuSections(menuEntries(rows))
    ._unsafeUnwrap()
    .map((section) => section.label);
}

function items(rows: CategoryCatalog, label: string): string[] {
  const section = categoryMenuSections(menuEntries(rows))
    ._unsafeUnwrap()
    .find((entry) => entry.label === label);
  return section?.items.map((item) => item.name) ?? [];
}

describe("renameCategoryGroup", () => {
  it("trims a new name and leaves other households alone", () => {
    const before = catalog();
    const next = renameCategoryGroup(before, house, "home", "  Shelter  ")._unsafeUnwrap();
    expect(next.groups.find((row) => row.id === "home")?.name).toBe("Shelter");
    expect(before.groups.find((row) => row.id === "home")?.name).toBe("Home");
    expectIsolated(before, next);
    expect(next.categories).toBe(before.categories);
  });

  it("allows the same name in another household", () => {
    const next = renameCategoryGroup(catalog(), house, "home", "Bills")._unsafeUnwrap();
    expect(next.groups.filter((row) => row.name === "Bills").map((row) => row.householdId).sort()).toEqual([
      house,
      other,
    ]);
  });

  it("rejects a duplicate, a blank name, and another household's group", () => {
    const before = catalog();
    const duplicate = expectUnchanged(before);
    duplicate.check(renameCategoryGroup(before, house, "home", " Fun "));
    expect(renameCategoryGroup(before, house, "home", " Fun ")._unsafeUnwrapErr().message).toBe(
      "That group already exists.",
    );

    const blank = expectUnchanged(before);
    blank.check(renameCategoryGroup(before, house, "home", " "));
    expect(renameCategoryGroup(catalog(), house, "home", " ")._unsafeUnwrapErr()).toBeInstanceOf(
      InvalidCategoryError,
    );
    expect(renameCategoryGroup(catalog(), house, "home", "a".repeat(81))._unsafeUnwrapErr().message).toBe(
      "Use a shorter name.",
    );

    const foreign = expectUnchanged(before);
    foreign.check(renameCategoryGroup(before, house, "bills", "Stolen"));
    expect(renameCategoryGroup(before, house, "bills", "Stolen")._unsafeUnwrapErr().message).toBe(
      "Choose a group in this household.",
    );
  });

  it("keeps the catalog when the name did not change", () => {
    const before = catalog();
    expect(renameCategoryGroup(before, house, "home", " Home ")._unsafeUnwrap()).toBe(before);
  });
});

describe("moveCategory", () => {
  it("appends a category to another group", () => {
    const before = catalog();
    const next = moveCategory(before, house, "rent", "fun")._unsafeUnwrap();
    const rent = next.categories.find((row) => row.id === "rent");
    expect(rent).toMatchObject({ groupId: "fun", sortOrder: 3 });
    expect(next.categories.find((row) => row.id === "groceries")).toMatchObject({ groupId: "home", sortOrder: 1 });
    expectIsolated(before, next);
    expect(before.categories.find((row) => row.id === "rent")?.groupId).toBe("home");
  });

  it("moves a category to the ungrouped list", () => {
    const before = catalog();
    const next = moveCategory(before, house, "groceries", null)._unsafeUnwrap();
    expect(next.categories.find((row) => row.id === "groceries")).toMatchObject({ groupId: null, sortOrder: 1 });
    expectIsolated(before, next);
  });

  it("rejects a name already in the destination, including ungrouped", () => {
    const grouped: CategoryCatalog = {
      groups: catalog().groups,
      categories: [...catalog().categories, category("named", house, "fun", "Rent", 4)],
    };
    const groupedResult = expectUnchanged(grouped);
    groupedResult.check(moveCategory(grouped, house, "named", "home"));
    expect(moveCategory(grouped, house, "named", "home")._unsafeUnwrapErr().message).toBe(
      "Rent is already in this group.",
    );

    const loose: CategoryCatalog = {
      groups: catalog().groups,
      categories: [...catalog().categories, category("named", house, "fun", "Paycheck", 4, "income")],
    };
    const looseResult = expectUnchanged(loose);
    looseResult.check(moveCategory(loose, house, "named", null));
    expect(moveCategory(loose, house, "named", null)._unsafeUnwrapErr().message).toBe(
      "Paycheck is already ungrouped.",
    );
  });

  it("rejects another household's category or group", () => {
    const before = catalog();
    const foreignCategory = expectUnchanged(before);
    foreignCategory.check(moveCategory(before, house, "secret", "home"));
    const foreignGroup = expectUnchanged(before);
    foreignGroup.check(moveCategory(before, house, "rent", "bills"));
    expect(moveCategory(before, house, "rent", "bills")._unsafeUnwrapErr().message).toBe(
      "Choose a group in this household.",
    );
  });

  it("does nothing when the category is already there", () => {
    const before = catalog();
    expect(moveCategory(before, house, "paycheck", null)._unsafeUnwrap()).toBe(before);
    expect(moveCategory(before, house, "rent", "home")._unsafeUnwrap()).toBe(before);
  });
});

describe("reorder groups and categories", () => {
  it("stores the full group order and ignores the other household", () => {
    const before = catalog();
    const next = reorderGroups(before, house, ["fun", "home"])._unsafeUnwrap();
    expect(next.groups.find((row) => row.id === "fun")?.sortOrder).toBe(0);
    expect(next.groups.find((row) => row.id === "home")?.sortOrder).toBe(1);
    expect(next.groups.find((row) => row.id === "bills")?.sortOrder).toBe(0);
    expect(next.categories).toBe(before.categories);
    expectIsolated(before, next);
  });

  it("steps a group using name order when sort orders tie", () => {
    const before: CategoryCatalog = {
      groups: [group("zoo", house, "Zoo", 0), group("alpha", house, "Alpha", 0), group("bills", other, "Bills", 0)],
      categories: catalog().categories,
    };
    const next = shiftGroup(before, house, "zoo", "up")._unsafeUnwrap();
    expect(next.groups.filter((row) => row.householdId === house).sort((a, b) => a.sortOrder - b.sortOrder)).toEqual([
      expect.objectContaining({ id: "zoo", sortOrder: 0 }),
      expect.objectContaining({ id: "alpha", sortOrder: 1 }),
    ]);
    expectIsolated(before, next);
  });

  it("steps a category inside its group and compacts the sort order", () => {
    const base = catalog();
    const before: CategoryCatalog = {
      groups: base.groups,
      categories: base.categories.map((row) => {
        if (row.id === "rent") return { ...row, sortOrder: 5 };
        if (row.id === "groceries") return { ...row, sortOrder: 9 };
        return row;
      }),
    };
    const next = shiftCategory(before, house, "groceries", "up")._unsafeUnwrap();
    expect(next.categories.find((row) => row.id === "groceries")).toMatchObject({ groupId: "home", sortOrder: 0 });
    expect(next.categories.find((row) => row.id === "rent")).toMatchObject({ groupId: "home", sortOrder: 1 });
    expect(next.categories.find((row) => row.id === "dining")?.sortOrder).toBe(1);
    expectIsolated(before, next);
  });

  it("reorders the ungrouped list without moving grouped categories", () => {
    const base = catalog();
    const before: CategoryCatalog = {
      groups: base.groups,
      categories: [...base.categories, category("bonus", house, null, "Bonus", 1, "income")],
    };
    const next = shiftCategory(before, house, "bonus", "up")._unsafeUnwrap();
    expect(next.categories.find((row) => row.id === "bonus")).toMatchObject({ groupId: null, sortOrder: 0 });
    expect(next.categories.find((row) => row.id === "paycheck")).toMatchObject({ groupId: null, sortOrder: 1 });
    expect(next.categories.find((row) => row.id === "rent")?.groupId).toBe("home");
    expectIsolated(before, next);
  });

  it("reorders only the categories in the chosen group", () => {
    const before = catalog();
    const next = reorderCategories(before, house, "home", ["groceries", "rent"])._unsafeUnwrap();
    expect(next.categories.find((row) => row.id === "groceries")?.sortOrder).toBe(0);
    expect(next.categories.find((row) => row.id === "rent")?.sortOrder).toBe(1);
    expect(next.categories.find((row) => row.id === "secret")?.sortOrder).toBe(3);
    expectIsolated(before, next);
  });

  it("leaves the ends where they are", () => {
    const before = catalog();
    expect(shiftGroup(before, house, "home", "up")._unsafeUnwrap()).toBe(before);
    expect(shiftGroup(before, house, "fun", "down")._unsafeUnwrap()).toBe(before);
    expect(shiftCategory(before, house, "rent", "up")._unsafeUnwrap()).toBe(before);
    expect(shiftCategory(before, house, "groceries", "down")._unsafeUnwrap()).toBe(before);
  });

  it("rejects a partial list, a foreign id, and a category from another group", () => {
    const before = catalog();
    expect(reorderGroups(before, house, ["home"])._unsafeUnwrapErr().message).toBe("Include every group once.");
    expect(reorderGroups(before, house, ["home", "home"])._unsafeUnwrapErr().message).toBe("Include every group once.");
    const foreign = expectUnchanged(before);
    foreign.check(reorderGroups(before, house, ["home", "bills"]));
    expect(reorderGroups(before, house, ["home", "bills"])._unsafeUnwrapErr().message).toBe(
      "Choose a group in this household.",
    );
    expect(shiftGroup(before, house, "bills", "up")._unsafeUnwrapErr().message).toBe(
      "Choose a group in this household.",
    );
    expect(reorderCategories(before, house, "bills", ["secret"])._unsafeUnwrapErr().message).toBe(
      "Choose a group in this household.",
    );
    expect(reorderCategories(before, house, "home", ["rent", "dining"])._unsafeUnwrapErr().message).toBe(
      "Include every category in this group once.",
    );
    expect(reorderCategories(before, house, "home", ["secret", "rent"])._unsafeUnwrapErr().message).toBe(
      "Choose a category in this household.",
    );
    expect(shiftCategory(before, house, "secret", "up")._unsafeUnwrapErr().message).toBe(
      "Choose a category in this household.",
    );
    expect(before).toEqual(catalog());
  });
});

describe("removeCategoryGroup", () => {
  it("removes an empty group without asking for a destination", () => {
    const base = catalog();
    const before: CategoryCatalog = {
      groups: [...base.groups, group("spare", house, "Spare", 2)],
      categories: base.categories,
    };
    const next = removeCategoryGroup(before, house, "spare")._unsafeUnwrap();
    expect(next.groups.some((row) => row.id === "spare")).toBe(false);
    expect(next.categories).toBe(before.categories);
    expectIsolated(before, next);
    const ignored = removeCategoryGroup(before, house, "spare", "fun")._unsafeUnwrap();
    expect(ignored.groups.some((row) => row.id === "spare")).toBe(false);
  });

  it("moves categories in their current order, then removes the group", () => {
    const before = catalog();
    const stepped = shiftCategory(before, house, "groceries", "up")._unsafeUnwrap();
    const next = removeCategoryGroup(stepped, house, "home", "fun")._unsafeUnwrap();
    expect(next.groups.some((row) => row.id === "home")).toBe(false);
    expect(next.categories.find((row) => row.id === "groceries")).toMatchObject({ groupId: "fun", sortOrder: 3 });
    expect(next.categories.find((row) => row.id === "rent")).toMatchObject({ groupId: "fun", sortOrder: 4 });
    expect(next.categories.find((row) => row.id === "dining")?.groupId).toBe("fun");
    expectIsolated(stepped, next);
  });

  it("moves categories to the ungrouped list", () => {
    const before = catalog();
    const next = removeCategoryGroup(before, house, "home", null)._unsafeUnwrap();
    expect(next.groups.some((row) => row.id === "home")).toBe(false);
    expect(next.categories.find((row) => row.id === "rent")).toMatchObject({ groupId: null, sortOrder: 1 });
    expect(next.categories.find((row) => row.id === "groceries")).toMatchObject({ groupId: null, sortOrder: 2 });
    expectIsolated(before, next);
  });

  it("asks where categories should go and refuses a bad destination", () => {
    const before = catalog();
    const missing = expectUnchanged(before);
    missing.check(removeCategoryGroup(before, house, "home"));
    expect(removeCategoryGroup(before, house, "home")._unsafeUnwrapErr().message).toBe(
      "Choose where those categories should go.",
    );
    expect(removeCategoryGroup(before, house, "home", "home")._unsafeUnwrapErr().message).toBe(
      "Choose a different group.",
    );
    const foreign = expectUnchanged(before);
    foreign.check(removeCategoryGroup(before, house, "home", "bills"));
    foreign.check(removeCategoryGroup(before, house, "bills", null));
    expect(removeCategoryGroup(before, house, "bills", null)._unsafeUnwrapErr().message).toBe(
      "Choose a group in this household.",
    );
  });

  it("does not remove the group when a category name is already in the destination", () => {
    const before: CategoryCatalog = {
      groups: [group("home", house, "Home", 0), group("fun", house, "Fun", 1), group("bills", other, "Bills", 0)],
      categories: [
        category("rent", house, "home", "Rent", 0),
        category("dining", house, "fun", "Dining out", 0),
        category("loose", house, null, "Dining out", 1),
        category("secret", other, "bills", "Secret", 3),
      ],
    };
    const result = removeCategoryGroup(before, house, "fun", null);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toBe("Dining out is already ungrouped.");
    expect(before.groups.some((row) => row.id === "fun")).toBe(true);
    const grouped = removeCategoryGroup(
      {
        groups: [group("home", house, "Home", 0), group("fun", house, "Fun", 1)],
        categories: [
          category("rent", house, "home", "Rent", 0),
          category("same", house, "fun", "Rent", 0),
        ],
      },
      house,
      "home",
      "fun",
    );
    expect(grouped._unsafeUnwrapErr().message).toBe("Rent is already in this group.");
  });

  it("does not rewrite a category that belongs to another household", () => {
    const base = catalog();
    const before: CategoryCatalog = {
      groups: base.groups,
      categories: [...base.categories, category("planted", other, "home", "Rent", 0)],
    };
    const next = removeCategoryGroup(before, house, "home", null)._unsafeUnwrap();
    expect(next.categories.find((row) => row.id === "planted")).toEqual(
      before.categories.find((row) => row.id === "planted"),
    );
    expect(next.categories.find((row) => row.id === "rent")?.groupId).toBeNull();
  });
});

describe("activity category menu", () => {
  it("follows the saved group order and category order, and still splits a group by kind", () => {
    const before = catalog();
    expect(labels(before)).toEqual([
      "Home · Expense",
      "Fun · Income",
      "Fun · Expense",
      "Fun · Transfer",
      "Ungrouped · Income",
    ]);

    const groups = shiftGroup(before, house, "home", "down")._unsafeUnwrap();
    expect(labels(groups)).toEqual([
      "Fun · Income",
      "Fun · Expense",
      "Fun · Transfer",
      "Home · Expense",
      "Ungrouped · Income",
    ]);

    const categories = shiftCategory(groups, house, "groceries", "up")._unsafeUnwrap();
    expect(items(categories, "Home · Expense")).toEqual(["Groceries", "Rent"]);
    expect(labels(categories)).toEqual([
      "Fun · Income",
      "Fun · Expense",
      "Fun · Transfer",
      "Home · Expense",
      "Ungrouped · Income",
    ]);

    const moved = moveCategory(categories, house, "paycheck", "fun")._unsafeUnwrap();
    expect(labels(moved)).toEqual(["Fun · Income", "Fun · Expense", "Fun · Transfer", "Home · Expense"]);
    expect(items(moved, "Fun · Income")).toEqual(["Gift", "Paycheck"]);

    const removed = removeCategoryGroup(moved, house, "home", "fun")._unsafeUnwrap();
    expect(labels(removed)).toEqual(["Fun · Income", "Fun · Expense", "Fun · Transfer"]);
    expect(items(removed, "Fun · Expense")).toEqual(["Dining out", "Groceries", "Rent"]);
    expectIsolated(before, removed);
  });
});
