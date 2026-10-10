import { describe, expect, it } from "vitest";
import { suggestRecurringItems, type SuggestionTransaction } from "./suggest";

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
      ["Netflix.Com", "NETFLIX.COM", "monthly", -1599, "2026-10-03"],
    ]);
    expect(suggestions[0].secondDayOfMonth).toBe(15);
    expect(suggestions[1].categoryId).toBe("cat-streaming");
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
});
