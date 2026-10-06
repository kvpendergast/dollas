import { describe, expect, it } from "vitest";
import { canAddSplit, MAX_TRANSACTION_SPLITS, SPLIT_CONTROL_COPY, SPLIT_LIMIT_MESSAGE, validateSplits } from "./splits";

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

  it("shares one cap for adding and editing", () => {
    const atCap = Array.from({ length: MAX_TRANSACTION_SPLITS }, (_, index) => ({
      categoryId: `category-${index}`,
      amountCents: -100,
    }));
    expect(validateSplits(-MAX_TRANSACTION_SPLITS * 100, atCap).isOk()).toBe(true);
    expect(canAddSplit(MAX_TRANSACTION_SPLITS - 1, 40)).toBe(true);
    expect(canAddSplit(MAX_TRANSACTION_SPLITS, 40)).toBe(false);
    expect(canAddSplit(2, 2)).toBe(false);

    const over = [...atCap, { categoryId: "one-more", amountCents: -100 }];
    const refused = validateSplits(-(MAX_TRANSACTION_SPLITS + 1) * 100, over);
    expect(refused.isErr()).toBe(true);
    if (refused.isErr()) expect(refused.error.message).toBe(SPLIT_LIMIT_MESSAGE);
    expect(SPLIT_CONTROL_COPY.limit).toBe(SPLIT_LIMIT_MESSAGE);
    expect(SPLIT_CONTROL_COPY.split).toBe("Split across categories");
    expect(SPLIT_CONTROL_COPY.single).toBe("Use one category");
    expect(SPLIT_CONTROL_COPY.add).toBe("Add a category");
    expect(SPLIT_CONTROL_COPY.remove).toBe("Remove");
    expect(SPLIT_CONTROL_COPY.hint).toBe("Each part is in dollars. The parts must add up to the amount.");
  });
});
