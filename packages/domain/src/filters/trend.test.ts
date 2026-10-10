import { describe, expect, it } from "vitest";
import { buildSpendingTrend, trendUnit } from "./trend";

describe("buildSpendingTrend", () => {
  it("uses Monday weeks for short ranges, clipped to the range, with the current week partial", () => {
    // Oct 1 2026 is a Thursday; today is Saturday Oct 10.
    const trend = buildSpendingTrend({
      lines: [
        { occurredOn: "2026-10-01", spentCents: 1000 },
        { occurredOn: "2026-10-04", spentCents: 500 },
        { occurredOn: "2026-10-05", spentCents: 2000 },
        { occurredOn: "2026-10-10", spentCents: 300 },
        { occurredOn: "2026-09-30", spentCents: 9999 },
      ],
      from: "2026-10-01",
      to: "2026-10-10",
      today: "2026-10-10",
    });
    expect(trend.unit).toBe("week");
    expect(trend.buckets.map((b) => [b.from, b.to, b.spentCents, b.partial])).toEqual([
      ["2026-10-01", "2026-10-04", 1500, false],
      ["2026-10-05", "2026-10-10", 2300, true],
    ]);
    expect(trend.buckets[0].change).toBeNull();
    expect(trend.buckets[1].change).toEqual({ comparable: false, label: "Not comparable yet" });
  });

  it("uses months beyond 62 days and compares finished months", () => {
    const trend = buildSpendingTrend({
      lines: [
        { occurredOn: "2026-07-15", spentCents: 1000 },
        { occurredOn: "2026-08-15", spentCents: 800 },
        { occurredOn: "2026-09-15", spentCents: 800 },
      ],
      from: "2026-07-12",
      to: "2026-10-10",
      today: "2026-10-10",
    });
    expect(trend.unit).toBe("month");
    expect(trend.buckets.map((b) => b.label)).toEqual(["Jul 26", "Aug 26", "Sep 26", "Oct 26"]);
    expect(trend.buckets[1].change).toEqual({ comparable: true, deltaCents: -200, direction: "less" });
    expect(trend.buckets[2].change).toEqual({ comparable: true, deltaCents: 0, direction: "same" });
    expect(trend.buckets[3]).toMatchObject({ partial: true, change: { comparable: false } });
  });

  it("a past range has no partial bucket", () => {
    const trend = buildSpendingTrend({ lines: [], from: "2025-01-01", to: "2025-12-31", today: "2026-10-10" });
    expect(trend.buckets).toHaveLength(12);
    expect(trend.buckets.some((b) => b.partial)).toBe(false);
    expect(trendUnit("2026-01-01", "2026-03-03")).toBe("week");
    expect(trendUnit("2026-01-01", "2026-03-04")).toBe("month");
  });
});
