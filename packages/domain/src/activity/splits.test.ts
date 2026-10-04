import { describe, expect, it } from "vitest";
import { validateSplits } from "./splits";

describe("validateSplits", () => {
  it("accepts a category split that adds up", () => {
    const result = validateSplits(-5_000, [
      { categoryId: "groceries", amountCents: -3_000 },
      { categoryId: "household", amountCents: -2_000 },
    ]);
    expect(result.isOk()).toBe(true);
  });

  it("rejects a split that does not match the total", () => {
    const result = validateSplits(-5_000, [
      { categoryId: "groceries", amountCents: -3_000 },
      { categoryId: "household", amountCents: -1_000 },
    ]);
    expect(result.isErr()).toBe(true);
  });
});
