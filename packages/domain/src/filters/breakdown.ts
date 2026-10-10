import { categoryBooksEffect } from "../categories/define";
import { addDays } from "../recurring/schedule";
import { buildSpendingTrend, type TrendBucket, type TrendUnit } from "./trend";

/**
 * Spending dashboard totals for already-filtered rows (PEN-212). Spending and
 * income follow the books, exactly as Home and History count them: money out on
 * expense categories is spent, money in on income categories is income, and
 * transfers are neither. Rows import and sync could not categorize sit in the
 * "Uncategorized" categories and show up as those categories.
 */

export type BreakdownLine = {
  transactionId: string;
  occurredOn: string;
  accountId: string;
  /** The member the breakdown attributes this row to (added by, or categorized by); null is Unknown. */
  memberId: string | null;
  categoryId: string;
  groupId: string | null;
  kind: string;
  /** The category line's signed amount. */
  amountCents: number;
};

export type BreakdownSlice = { key: string | null; spentCents: number; incomeCents: number; transactionCount: number };

export type SpendingBreakdown = {
  from: string | null;
  to: string | null;
  totals: { spentCents: number; incomeCents: number; netCents: number; transactionCount: number };
  byCategory: BreakdownSlice[];
  byGroup: BreakdownSlice[];
  byAccount: BreakdownSlice[];
  byMember: BreakdownSlice[];
  trend: { unit: TrendUnit; from: string; to: string; truncated: boolean; buckets: TrendBucket[] };
};

const MAX_TREND_DAYS = 3 * 366;

function slices(map: Map<string | null, { spent: number; income: number; ids: Set<string> }>): BreakdownSlice[] {
  return [...map.entries()]
    .map(([key, value]) => ({ key, spentCents: value.spent, incomeCents: value.income, transactionCount: value.ids.size }))
    .sort((a, b) => b.spentCents - a.spentCents || b.incomeCents - a.incomeCents || String(a.key).localeCompare(String(b.key)));
}

export function buildSpendingBreakdown(input: {
  lines: readonly BreakdownLine[];
  from: string | null;
  to: string | null;
  today: string;
}): SpendingBreakdown {
  const byCategory = new Map<string | null, { spent: number; income: number; ids: Set<string> }>();
  const byGroup = new Map<string | null, { spent: number; income: number; ids: Set<string> }>();
  const byAccount = new Map<string | null, { spent: number; income: number; ids: Set<string> }>();
  const byMember = new Map<string | null, { spent: number; income: number; ids: Set<string> }>();
  const all = new Set<string>();
  const trendLines: { occurredOn: string; spentCents: number }[] = [];
  let spent = 0;
  let income = 0;
  const add = (map: typeof byCategory, key: string | null, s: number, i: number, id: string) => {
    const row = map.get(key) ?? { spent: 0, income: 0, ids: new Set<string>() };
    row.spent += s;
    row.income += i;
    row.ids.add(id);
    map.set(key, row);
  };
  for (const line of input.lines) {
    all.add(line.transactionId);
    const effect = categoryBooksEffect(line.kind, line.amountCents);
    const s = effect.isOk() ? effect.value.spentCents : 0;
    const i = effect.isOk() ? effect.value.incomeCents : 0;
    spent += s;
    income += i;
    add(byCategory, line.categoryId, s, i, line.transactionId);
    add(byGroup, line.groupId, s, i, line.transactionId);
    add(byAccount, line.accountId, s, i, line.transactionId);
    add(byMember, line.memberId, s, i, line.transactionId);
    if (s !== 0) trendLines.push({ occurredOn: line.occurredOn, spentCents: s });
  }

  const dates = input.lines.map((line) => line.occurredOn).sort();
  const trendTo = input.to ?? (dates.length > 0 && dates[dates.length - 1] < input.today ? input.today : (dates[dates.length - 1] ?? input.today));
  let trendFrom = input.from ?? dates[0] ?? trendTo;
  let truncated = false;
  if (addDays(trendFrom, MAX_TREND_DAYS) < trendTo) {
    trendFrom = `${addDays(trendTo, -MAX_TREND_DAYS + 31).slice(0, 7)}-01`;
    truncated = true;
  }
  const trend = buildSpendingTrend({ lines: trendLines, from: trendFrom, to: trendTo, today: input.today });

  return {
    from: input.from,
    to: input.to,
    totals: { spentCents: spent, incomeCents: income, netCents: income - spent, transactionCount: all.size },
    byCategory: slices(byCategory),
    byGroup: slices(byGroup),
    byAccount: slices(byAccount),
    byMember: slices(byMember),
    trend: { unit: trend.unit, from: trendFrom, to: trendTo, truncated, buckets: trend.buckets },
  };
}
