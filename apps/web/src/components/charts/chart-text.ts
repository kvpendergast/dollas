import { formatCents, type HistoryColumn, type TrendBucket } from "@dollas/domain";

/**
 * Words for the charts (PEN-208): every delta reads as text with a sign and a
 * named comparison, so color is never the only signal. Pure, for the History
 * chart, the dashboard trend, and their screen-reader summaries.
 */

export type Direction = "less" | "more" | "same";
export type Tone = "less" | "more" | "same" | "muted";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function shortMonthYear(year: number, month: number): string {
  return `${MONTHS[month - 1]} ${year}`;
}

export function previousMonth(year: number, month: number): { year: number; month: number } {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

/** "−$42.00" for less, "+$18.00" for more (a true minus sign, read as "minus"). */
export function signedCents(direction: Direction, deltaCents: number): string {
  const amount = formatCents(Math.abs(deltaCents));
  if (direction === "same") return amount;
  return `${direction === "less" ? "\u2212" : "+"}${amount}`;
}

/** "−$42.00, less than Sep 2026" · "+$18.00, more than Sep 2026" · "Same as Sep 2026". */
export function deltaSentence(direction: Direction, deltaCents: number, against: string): string {
  if (direction === "same" || deltaCents === 0) return `Same as ${against}`;
  return `${signedCents(direction, deltaCents)}, ${direction} than ${against}`;
}

/** Whole dollars, thousands as "$1.2k": short enough for a 12px label under a narrow column. */
export function compactCents(cents: number): string {
  const dollars = Math.round(cents / 100);
  if (Math.abs(dollars) < 1000) return `$${dollars.toLocaleString("en-US")}`;
  const thousands = dollars / 1000;
  return `$${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, "")}k`;
}

export type ChartLine = { text: string; tone: Tone };
export type ChartRow = { key: string; label: string; amount: string; partial: boolean; lines: ChartLine[] };

/** The History chart's months as rows, newest first: month over month and year over year, in words. */
export function historyRows(columns: readonly HistoryColumn[]): ChartRow[] {
  return [...columns].reverse().map((column) => {
    const prior = previousMonth(column.year, column.month);
    const lastMonth = shortMonthYear(prior.year, prior.month);
    const lastYear = shortMonthYear(column.year - 1, column.month);
    const mom = column.monthOverMonth;
    const lines: ChartLine[] = [
      {
        text: deltaSentence(mom.direction, mom.deltaCents, column.partial ? `the same days of ${lastMonth}` : lastMonth),
        tone: mom.direction,
      },
      column.yearOverYear.comparable
        ? { text: deltaSentence(column.yearOverYear.direction, column.yearOverYear.deltaCents, lastYear), tone: column.yearOverYear.direction }
        : { text: `Not comparable yet with ${lastYear}`, tone: "muted" },
    ];
    return {
      key: `${column.year}-${column.month}`,
      label: shortMonthYear(column.year, column.month),
      amount: formatCents(column.spentCents),
      partial: column.partial,
      lines,
    };
  });
}

/** One paragraph a screen reader can read instead of the bars. */
export function historySummary(columns: readonly HistoryColumn[]): string {
  if (columns.length === 0) return "No spending history yet.";
  const first = columns[0];
  const last = columns[columns.length - 1];
  const finished = columns.filter((column) => !column.partial);
  const top = [...finished].sort((a, b) => b.spentCents - a.spentCents)[0];
  const parts = [`Spending by month from ${shortMonthYear(first.year, first.month)} to ${shortMonthYear(last.year, last.month)}.`];
  if (top && top.spentCents > 0) parts.push(`The highest month was ${shortMonthYear(top.year, top.month)} at ${formatCents(top.spentCents)}.`);
  const newest = historyRows([last])[0];
  parts.push(`${newest.partial ? "This month so far" : newest.label}: ${newest.amount}; ${newest.lines.map((line) => line.text).join("; ")}.`);
  return parts.join(" ");
}

/** Dashboard trend buckets as rows, newest first. */
export function trendRows(buckets: readonly TrendBucket[], unit: "week" | "month"): ChartRow[] {
  const before = unit === "week" ? "the week before" : "the month before";
  return buckets
    .map((bucket): ChartRow => {
      const lines: ChartLine[] = [];
      if (bucket.change?.comparable) lines.push({ text: deltaSentence(bucket.change.direction, bucket.change.deltaCents, before), tone: bucket.change.direction });
      else if (bucket.change) lines.push({ text: "Not comparable yet", tone: "muted" });
      return {
        key: bucket.from,
        label: unit === "week" ? `Week of ${bucket.label}` : bucket.label,
        amount: formatCents(bucket.spentCents),
        partial: bucket.partial,
        lines,
      };
    })
    .reverse();
}

export function trendSummary(buckets: readonly TrendBucket[], unit: "week" | "month"): string {
  if (buckets.length === 0) return "No spending in this range.";
  const rows = trendRows(buckets, unit);
  const newest = rows[0];
  const total = buckets.reduce((sum, bucket) => sum + bucket.spentCents, 0);
  return `Spending by ${unit}, ${buckets.length} ${unit}s, ${formatCents(total)} in all. ${newest.label}${newest.partial ? " so far" : ""}: ${newest.amount}${newest.lines.length ? `; ${newest.lines.map((line) => line.text).join("; ")}` : ""}.`;
}
