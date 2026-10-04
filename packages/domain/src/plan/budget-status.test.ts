import { describe, expect, it } from "vitest";
import { budgetStanding } from "./budget-status";

describe("budgetStanding", () => {
  it("flags spend past the monthly budget", () => {
    expect(budgetStanding(8_000, 5_000)).toBe("over");
    expect(budgetStanding(5_000, 5_000)).toBe("within");
    expect(budgetStanding(100, null)).toBe("unbudgeted");
  });
});
