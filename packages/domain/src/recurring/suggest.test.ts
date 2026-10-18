import { describe, expect, it } from "vitest";
import { cleanSuggestionName, suggestRecurringItems, type SuggestionTransaction } from "./suggest";

const row = (payee: string, occurredOn: string, amountCents: number, extra: Partial<SuggestionTransaction> = {}): SuggestionTransaction => ({
  payee,
  occurredOn,
  amountCents,
  accountId: "acct-1",
  categoryId: "cat-streaming",
  deleted: false,
  ...extra,
});

describe("recurring suggestions", () => {
  it("finds a monthly bill and a twice-monthly paycheck", () => {
    const suggestions = suggestRecurringItems({
      today: "2026-10-10",
      existingPayeeMatches: [],
      transactions: [
        row("NETFLIX.COM 4411", "2026-07-03", -1599),
        row("NETFLIX.COM 9921", "2026-08-03", -1599),
        row("NETFLIX.COM 1022", "2026-09-03", -1599),
        row("NETFLIX.COM 5512", "2026-10-03", -1599),
        row("ACME PAYROLL", "2026-08-15", 250000, { categoryId: null }),
        row("ACME PAYROLL", "2026-08-31", 250000, { categoryId: null }),
        row("ACME PAYROLL", "2026-09-15", 250000, { categoryId: null }),
        row("ACME PAYROLL", "2026-09-30", 251000, { categoryId: null }),
        row("Corner Coffee", "2026-09-02", -450),
        row("Corner Coffee", "2026-09-05", -800),
        row("Corner Coffee", "2026-09-21", -450),
      ],
    });
    expect(suggestions.map((s) => [s.name, s.payeeMatch, s.cadence, s.amountCents, s.anchorDate])).toEqual([
      ["Acme Payroll", "ACME PAYROLL", "semimonthly", 250000, "2026-09-30"],
      ["Netflix", "NETFLIX.COM", "monthly", -1599, "2026-10-03"],
    ]);
    expect(suggestions[0].secondDayOfMonth).toBe(15);
    expect(suggestions[1].categoryId).toBe("cat-streaming");
    expect(suggestions.map((s) => s.tolerancePercent)).toEqual([5, 5]);
  });

  it("skips payees an item covers, stopped series, deleted rows, and uneven amounts", () => {
    const monthly = ["2026-06-03", "2026-07-03", "2026-08-03"];
    const base = monthly.map((date) => row("Gym Club", date, -4000));
    expect(suggestRecurringItems({ today: "2026-08-10", existingPayeeMatches: ["gym"], transactions: base })).toEqual([]);
    expect(suggestRecurringItems({ today: "2026-10-30", existingPayeeMatches: [], transactions: base })).toEqual([]);
    expect(
      suggestRecurringItems({ today: "2026-08-10", existingPayeeMatches: [], transactions: base.map((r, i) => ({ ...r, deleted: i === 0 })) }),
    ).toEqual([]);
    expect(
      suggestRecurringItems({ today: "2026-08-10", existingPayeeMatches: [], transactions: base.map((r, i) => ({ ...r, amountCents: -4000 - i * 1000 })) }),
    ).toEqual([]);
    expect(suggestRecurringItems({ today: "2026-08-10", existingPayeeMatches: [], transactions: base })).toHaveLength(1);
  });

  it("finds bills whose day of month moves (PEN-322)", () => {
    const suggestions = suggestRecurringItems({
      today: "2026-10-10",
      existingPayeeMatches: [],
      transactions: [
        row("MORTGAGE CO", "2026-06-01", -210000),
        row("MORTGAGE CO", "2026-07-03", -210000),
        row("MORTGAGE CO", "2026-08-02", -210000),
        row("MORTGAGE CO", "2026-09-04", -210000),
        row("MORTGAGE CO", "2026-10-01", -210000),
        row("COMCAST CABLE", "2026-06-20", -9000),
        row("COMCAST CABLE", "2026-07-28", -9100),
        row("COMCAST CABLE", "2026-08-24", -9000),
        row("COMCAST CABLE", "2026-09-30", -9050),
      ],
    });
    expect(suggestions.map((s) => [s.payeeMatch, s.cadence, s.count])).toEqual([
      ["MORTGAGE CO", "monthly", 5],
      ["COMCAST CABLE", "monthly", 4],
    ]);
  });

  it("does not call two random charges a month a monthly bill, or days that are far apart", () => {
    const wild = ["2026-06-02", "2026-07-25", "2026-08-09", "2026-09-28"].map((d) => row("Odd Shop", d, -5000));
    expect(suggestRecurringItems({ today: "2026-10-10", existingPayeeMatches: [], transactions: wild })).toEqual([]);
    const twice = ["2026-07-01", "2026-07-06", "2026-08-02", "2026-08-07", "2026-09-01", "2026-09-05", "2026-10-02"].map((d) => row("Twice Shop", d, -5000));
    expect(suggestRecurringItems({ today: "2026-10-10", existingPayeeMatches: [], transactions: twice })).toEqual([]);
  });

  it("counts every charge the payee text would link, including ones outside the series (PEN-324)", () => {
    const dates = ["2026-02-03", "2026-03-03", "2026-04-03", "2026-05-03", "2026-06-03", "2026-07-03", "2026-08-03", "2026-09-03", "2026-10-03"];
    const rows = dates.map((d, i) => row(i % 3 === 0 ? "GYM CLUB 11" : "GYM CLUB", d, -4000));
    rows.push(row("GYM CLUB REFUND", "2026-09-10", 4000));
    const [only] = suggestRecurringItems({ today: "2026-10-10", existingPayeeMatches: [], transactions: rows, lookbackDays: 300 });
    expect(only.count).toBe(9);
  });

  it("gives readable names and keeps the raw text as the match (PEN-325)", () => {
    expect(cleanSuggestionName("PEO UNITYAI INC PAYROLL PPD ID")).toBe("Unityai Payroll");
    expect(cleanSuggestionName("NETFLIX.COM")).toBe("Netflix");
    expect(cleanSuggestionName("SQ *BLUE BOTTLE 4411")).toBe("Blue Bottle");
    expect(cleanSuggestionName("ACH WEB ID")).toBe("Ach Web Id");
    const [s] = suggestRecurringItems({
      today: "2026-10-10",
      existingPayeeMatches: [],
      transactions: ["2026-08-14", "2026-08-28", "2026-09-11", "2026-09-25"].map((d) => row("PEO UNITYAI INC PAYROLL PPD ID 123", d, 300000)),
    });
    expect(s.name).toBe("Unityai Payroll");
    expect(s.payeeMatch).toContain("PEO UNITYAI INC PAYROLL PPD ID");
  });

  it("groups payee variants of one employer across accounts and allows a varying paycheck (PEN-323)", () => {
    const [s, ...rest] = suggestRecurringItems({
      today: "2026-10-10",
      existingPayeeMatches: [],
      transactions: [
        row("PEO UNITYAI INC PAYROLL PPD ID 111", "2026-08-14", 210000, { accountId: "checking", categoryId: null }),
        row("UNITYAI PAYROLL ACH", "2026-08-28", 260000, { accountId: "savings", categoryId: null }),
        row("PEO UNITYAI INC PAYROLL PPD ID 222", "2026-09-11", 230000, { accountId: "checking", categoryId: null }),
        row("UNITYAI PAYROLL ACH", "2026-09-25", 280000, { accountId: "checking", categoryId: null }),
        row("PEO UNITYAI INC PAYROLL PPD ID 333", "2026-10-09", 240000, { accountId: "checking", categoryId: null }),
      ],
    });
    expect(rest).toEqual([]);
    expect(s.name).toBe("Unityai Payroll");
    expect(s.payeeMatch.toLowerCase()).toBe("unityai");
    expect(s.count).toBe(5);
    expect(s.cadence).toBe("biweekly");
    expect(s.accountId).toBeNull();
    expect(s.variableAmount).toBe(true);
    expect(s.tolerancePercent).toBeGreaterThan(10);
    expect(s.tolerancePercent).toBeLessThanOrEqual(50);
  });

  it("keeps a fixed paycheck non-variable, and never treats a varying bill as variable", () => {
    const pay = ["2026-08-14", "2026-08-28", "2026-09-11", "2026-09-25"].map((d) => row("ACME PAYROLL", d, 300000, { categoryId: null }));
    expect(suggestRecurringItems({ today: "2026-10-01", existingPayeeMatches: [], transactions: pay })[0].variableAmount).toBe(false);
    const bill = ["2026-07-03", "2026-08-03", "2026-09-03"].map((d, i) => row("Water Co", d, -4000 - i * 1500));
    expect(suggestRecurringItems({ today: "2026-10-01", existingPayeeMatches: [], transactions: bill })).toEqual([]);
  });
});
