import type { HistoryColumn, TrendBucket } from "@dollas/domain";
import { describe, expect, it } from "vitest";
import { compactCents, deltaSentence, historyRows, historySummary, signedCents, trendRows, trendSummary } from "./chart-text";

const column = (month: number, spentCents: number, extra: Partial<HistoryColumn> = {}): HistoryColumn => ({
  year: 2026,
  month,
  spentCents,
  priorYearSpentCents: 0,
  partial: false,
  partialLabel: null,
  monthOverMonth: { deltaCents: 0, direction: "same" },
  yearOverYear: { comparable: false, label: "Not comparable yet" },
  ...extra,
});

describe("chart text deltas (PEN-208)", () => {
  it("puts a sign and words on every delta", () => {
    expect(signedCents("less", -4200)).toBe("\u2212$42.00");
    expect(signedCents("more", 1800)).toBe("+$18.00");
    expect(deltaSentence("less", -4200, "Oct 2025")).toBe("\u2212$42.00, less than Oct 2025");
    expect(deltaSentence("more", 1800, "Sep 2026")).toBe("+$18.00, more than Sep 2026");
    expect(deltaSentence("same", 0, "Sep 2026")).toBe("Same as Sep 2026");
  });

  it("names the months it compares, and says when a month is not comparable", () => {
    const rows = historyRows([
      column(9, 50000, { yearOverYear: { comparable: true, deltaCents: -4200, direction: "less" }, monthOverMonth: { deltaCents: 1000, direction: "more" } }),
      column(10, 20000, { partial: true, partialLabel: "so far", monthOverMonth: { deltaCents: -500, direction: "less" } }),
    ]);
    expect(rows.map((row) => row.label)).toEqual(["Oct 2026", "Sep 2026"]);
    expect(rows[0].partial).toBe(true);
    expect(rows[0].lines.map((line) => line.text)).toEqual(["\u2212$5.00, less than the same days of Sep 2026", "Not comparable yet with Oct 2025"]);
    expect(rows[0].lines[1].tone).toBe("muted");
    expect(rows[1].lines.map((line) => line.text)).toEqual(["+$10.00, more than Aug 2026", "\u2212$42.00, less than Sep 2025"]);
    expect(historyRows([column(1, 100, { monthOverMonth: { deltaCents: -1, direction: "less" } })])[0].lines[0].text).toContain("Dec 2025");
  });

  it("summarizes the chart for screen readers", () => {
    const summary = historySummary([column(8, 90000), column(9, 50000), column(10, 20000, { partial: true, partialLabel: "so far" })]);
    expect(summary).toContain("from Aug 2026 to Oct 2026");
    expect(summary).toContain("highest month was Aug 2026 at $900.00");
    expect(summary).toContain("This month so far: $200.00");
    expect(historySummary([])).toBe("No spending history yet.");
  });

  it("keeps column labels short", () => {
    expect(compactCents(84250)).toBe("$843");
    expect(compactCents(123456)).toBe("$1.2k");
    expect(compactCents(200000)).toBe("$2k");
    expect(compactCents(15000000)).toBe("$150k");
  });

  it("words the dashboard trend too", () => {
    const buckets: TrendBucket[] = [
      { from: "2026-09-28", to: "2026-10-04", label: "Sep 28", spentCents: 10000, partial: false, clipped: false, change: null },
      { from: "2026-10-05", to: "2026-10-11", label: "Oct 5", spentCents: 6000, partial: true, clipped: false, change: { comparable: false, label: "Not comparable yet" } },
    ];
    const rows = trendRows(buckets, "week");
    expect(rows[0]).toMatchObject({ label: "Week of Oct 5", partial: true, lines: [{ text: "Not comparable yet", tone: "muted" }] });
    const monthly = trendRows([{ ...buckets[0], label: "Sep", change: { comparable: true, deltaCents: -2500, direction: "less" } }], "month");
    expect(monthly[0].lines[0].text).toBe("\u2212$25.00, less than the month before");
    expect(trendSummary(buckets, "week")).toContain("2 weeks, $160.00 in all");
  });
});
