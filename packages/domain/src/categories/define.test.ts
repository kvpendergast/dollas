import { describe, expect, it } from "vitest";
import { InvalidCategoryError, InvalidMoneyError } from "../errors";
import { categoryBooksEffect, categoryKinds, defineCategory, defineCategoryGroup } from "./define";

describe("defineCategoryGroup", () => {
  it("trims a group name", () => {
    expect(defineCategoryGroup("  Everyday  ")._unsafeUnwrap()).toEqual({ name: "Everyday" });
  });

  it("rejects a blank group", () => {
    const result = defineCategoryGroup("  ");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(InvalidCategoryError);
  });
});

describe("defineCategory", () => {
  it.each(categoryKinds)("accepts a grouped %s category", (kind) => {
    expect(
      defineCategory({ name: "  Coffee ", kind, groupId: " group-1 " })._unsafeUnwrap(),
    ).toEqual({
      name: "Coffee",
      kind,
      groupId: "group-1",
    });
  });

  it("rejects a category without a group", () => {
    const result = defineCategory({ name: "Coffee", kind: "expense", groupId: " " });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toBe("Choose a group.");
  });

  it("rejects an unknown kind", () => {
    const result = defineCategory({ name: "Coffee", kind: "savings", groupId: "group-1" });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(InvalidCategoryError);
  });
});

describe("categoryBooksEffect", () => {
  it("counts income and expense in integer cents and ignores transfers", () => {
    expect(categoryBooksEffect("income", 320_000)._unsafeUnwrap()).toEqual({
      incomeCents: 320_000,
      spentCents: 0,
    });
    expect(categoryBooksEffect("expense", -450)._unsafeUnwrap()).toEqual({
      incomeCents: 0,
      spentCents: 450,
    });
    expect(categoryBooksEffect("transfer", -12_000)._unsafeUnwrap()).toEqual({
      incomeCents: 0,
      spentCents: 0,
    });
    expect(categoryBooksEffect("transfer", 12_000)._unsafeUnwrap()).toEqual({
      incomeCents: 0,
      spentCents: 0,
    });
  });

  it("does not treat the wrong sign as the other kind", () => {
    expect(categoryBooksEffect("expense", 100)._unsafeUnwrap()).toEqual({ incomeCents: 0, spentCents: 0 });
    expect(categoryBooksEffect("income", -100)._unsafeUnwrap()).toEqual({ incomeCents: 0, spentCents: 0 });
  });

  it("rejects money that is not integer cents", () => {
    const result = categoryBooksEffect("expense", 1.5);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(InvalidMoneyError);
  });
});
