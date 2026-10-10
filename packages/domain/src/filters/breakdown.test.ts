import { describe, expect, it } from "vitest";
import { buildSpendingBreakdown, type BreakdownLine } from "./breakdown";

const line = (over: Partial<BreakdownLine>): BreakdownLine => ({
  transactionId: "t1",
  occurredOn: "2026-10-02",
  accountId: "checking",
  memberId: "ada",
  categoryId: "groceries",
  groupId: "food",
  kind: "expense",
  amountCents: -1000,
  ...over,
});

describe("buildSpendingBreakdown", () => {
  it("totals spending and income by the books, and slices by category, group, account, and member", () => {
    const result = buildSpendingBreakdown({
      from: "2026-10-01",
      to: "2026-10-10",
      today: "2026-10-10",
      lines: [
        line({ transactionId: "t1", amountCents: -3000 }),
        // A split transaction: two lines, one transaction.
        line({ transactionId: "t2", categoryId: "groceries", amountCents: -500 }),
        line({ transactionId: "t2", categoryId: "dining", groupId: "food", amountCents: -700 }),
        line({ transactionId: "t3", categoryId: "rent", groupId: null, accountId: "card", memberId: null, amountCents: -150000 }),
        line({ transactionId: "t4", categoryId: "pay", groupId: null, kind: "income", amountCents: 250000 }),
        line({ transactionId: "t5", categoryId: "move", groupId: null, kind: "transfer", amountCents: -90000 }),
        // An expense refund (money in on an expense category) is not spending, as on Home.
        line({ transactionId: "t6", amountCents: 400 }),
      ],
    });
    expect(result.totals).toEqual({ spentCents: 3000 + 500 + 700 + 150000, incomeCents: 250000, netCents: 250000 - 154200, transactionCount: 6 });
    expect(result.byCategory.map((row) => [row.key, row.spentCents, row.transactionCount])).toEqual([
      ["rent", 150000, 1],
      ["groceries", 3500, 3],
      ["dining", 700, 1],
      ["pay", 0, 1],
      ["move", 0, 1],
    ]);
    expect(result.byGroup.find((row) => row.key === "food")).toMatchObject({ spentCents: 4200, transactionCount: 3 });
    expect(result.byAccount.map((row) => [row.key, row.spentCents])).toEqual([
      ["card", 150000],
      ["checking", 4200],
    ]);
    expect(result.byMember.map((row) => [row.key, row.spentCents])).toEqual([
      [null, 150000],
      ["ada", 4200],
    ]);
    expect(result.trend.unit).toBe("week");
    expect(result.trend.buckets.reduce((sum, bucket) => sum + bucket.spentCents, 0)).toBe(result.totals.spentCents);
  });

  it("an open range runs the trend from the first row through today, capped at about three years", () => {
    const open = buildSpendingBreakdown({ from: null, to: null, today: "2026-10-10", lines: [line({ occurredOn: "2026-05-03" })] });
    expect(open.trend).toMatchObject({ unit: "month", from: "2026-05-03", to: "2026-10-10", truncated: false });
    const long = buildSpendingBreakdown({ from: null, to: null, today: "2026-10-10", lines: [line({ occurredOn: "2019-01-01" })] });
    expect(long.trend.truncated).toBe(true);
    expect(long.trend.buckets.length).toBeLessThanOrEqual(37);
    const empty = buildSpendingBreakdown({ from: null, to: null, today: "2026-10-10", lines: [] });
    expect(empty.totals.transactionCount).toBe(0);
    expect(empty.trend.buckets).toHaveLength(1);
  });
});
