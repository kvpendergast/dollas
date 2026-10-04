import { describe, expect, it } from "vitest";
import { formatCents, parseDollarInput } from "./cents";

describe("parseDollarInput", () => {
  it("parses dollars into integer cents", () => {
    expect(parseDollarInput("12.34")._unsafeUnwrap()).toBe(1234);
    expect(parseDollarInput("$1,800")._unsafeUnwrap()).toBe(180000);
    expect(parseDollarInput("12.3")._unsafeUnwrap()).toBe(1230);
    expect(parseDollarInput("-4.50")._unsafeUnwrap()).toBe(-450);
  });

  it("rejects fractions smaller than a cent", () => {
    expect(parseDollarInput("12.345").isErr()).toBe(true);
    expect(parseDollarInput("").isErr()).toBe(true);
    expect(parseDollarInput("abc").isErr()).toBe(true);
  });
});

describe("formatCents", () => {
  it("formats signed cents as currency", () => {
    expect(formatCents(180000)).toBe("$1,800.00");
    expect(formatCents(-1234)).toBe("-$12.34");
    expect(formatCents(1)).toBe("$0.01");
  });
});
