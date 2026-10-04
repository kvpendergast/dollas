import { describe, expect, it } from "vitest";
import { estimateMonthSpend } from "./estimate";

describe("estimateMonthSpend", () => {
  it("projects the month from pace so far and labels it an estimate", () => {
    const result = estimateMonthSpend({
      spentSoFarCents: 31_000,
      asOf: { year: 2026, month: 10, day: 4 },
    })._unsafeUnwrap();
    expect(result.kind).toBe("estimate");
    expect(result.daysInMonth).toBe(31);
    expect(result.daysElapsed).toBe(4);
    expect(result.estimateCents).toBe(Math.round((31_000 * 31) / 4));
  });
});
