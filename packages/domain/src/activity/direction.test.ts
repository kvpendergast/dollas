import { describe, expect, it } from "vitest";
import { directionCategoryNotice, directionDefaultForKind } from "./direction";

describe("direction and category kind", () => {
  it("defaults expense and income from the category, and leaves transfers alone", () => {
    expect(directionDefaultForKind("expense")).toBe("expense");
    expect(directionDefaultForKind("income")).toBe("income");
    expect(directionDefaultForKind("transfer")).toBeNull();
    expect(directionDefaultForKind("other")).toBeNull();
  });

  it("warns when direction and category kind disagree", () => {
    expect(directionCategoryNotice("expense", "expense")).toBeNull();
    expect(directionCategoryNotice("income", "income")).toBeNull();
    expect(directionCategoryNotice("expense", "income")).toEqual({
      tone: "warning",
      message: "This category is income, but the direction is an expense.",
    });
    expect(directionCategoryNotice("income", "expense")).toEqual({
      tone: "warning",
      message: "This category is an expense, but the direction is income.",
    });
  });

  it("explains a transfer without treating either direction as a mismatch", () => {
    const note = {
      tone: "note",
      message: "Transfers move money between accounts and do not count as income or spending.",
    };
    expect(directionCategoryNotice("expense", "transfer")).toEqual(note);
    expect(directionCategoryNotice("income", "transfer")).toEqual(note);
  });
});
