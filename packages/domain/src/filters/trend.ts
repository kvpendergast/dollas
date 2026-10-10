import { addDays, dayNumber, daysInMonth } from "../recurring/schedule";

export type TrendBucket = {
  /** First and last civil day this bucket covers (clipped to the range). */
  from: string;
  to: string;
  label: string;
  spentCents: number;
  /** Contains today and runs past it: shown hatched as "so far". */
  partial: boolean;
  /** Starts after its natural week or month start because the range does; the next bucket does not compare against it. */
  clipped: boolean;
  /** Change from the previous bucket; a partial bucket is not comparable yet. */
  change: { comparable: true; deltaCents: number; direction: "less" | "more" | "same" } | { comparable: false; label: "Not comparable yet" } | null;
};

export type TrendUnit = "week" | "month";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDay(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
}

/** Weeks (Monday start) for ranges up to 62 days, months beyond. */
export function trendUnit(from: string, to: string): TrendUnit {
  return dayNumber(to) - dayNumber(from) + 1 <= 62 ? "week" : "month";
}

/**
 * Spending over a range in buckets, for the dashboard trend. The bucket that
 * holds today is partial ("so far") and its change is "Not comparable yet",
 * matching History. Lines outside the range are ignored.
 */
export function buildSpendingTrend(input: {
  lines: readonly { occurredOn: string; spentCents: number }[];
  from: string;
  to: string;
  today: string;
}): { unit: TrendUnit; buckets: TrendBucket[] } {
  const { from, to, today } = input;
  if (to < from) return { unit: "week", buckets: [] };
  const unit = trendUnit(from, to);
  const buckets: TrendBucket[] = [];
  let cursor = from;
  while (cursor <= to) {
    let end: string;
    if (unit === "week") {
      const weekday = (dayNumber(cursor) + 3) % 7; // 0 = Monday (day 0 is 1970-01-01, a Thursday)
      end = addDays(cursor, 6 - weekday);
    } else {
      const y = Number(cursor.slice(0, 4));
      const m = Number(cursor.slice(5, 7));
      end = `${cursor.slice(0, 7)}-${String(daysInMonth(y, m)).padStart(2, "0")}`;
    }
    const naturalEnd = end;
    if (end > to) end = to;
    const clipped = unit === "week" ? (dayNumber(cursor) + 3) % 7 !== 0 : cursor.slice(8) !== "01";
    const label = unit === "week" || clipped ? `${shortDay(cursor)}${clipped && unit === "month" ? "–" : ""}` : `${MONTHS[Number(cursor.slice(5, 7)) - 1]} ${cursor.slice(2, 4)}`;
    buckets.push({ from: cursor, to: end, label, spentCents: 0, partial: today >= cursor && today < naturalEnd && today <= end, clipped: clipped && buckets.length === 0, change: null });
    cursor = addDays(end, 1);
  }
  for (const line of input.lines) {
    if (line.occurredOn < from || line.occurredOn > to) continue;
    const bucket = buckets.find((row) => line.occurredOn >= row.from && line.occurredOn <= row.to);
    if (bucket) bucket.spentCents += line.spentCents;
  }
  buckets.forEach((bucket, index) => {
    if (index === 0) return;
    if (bucket.partial) {
      bucket.change = { comparable: false, label: "Not comparable yet" };
      return;
    }
    // A bucket after a clipped first bucket would compare against a part of a week or month.
    if (buckets[index - 1].clipped) return;
    const deltaCents = bucket.spentCents - buckets[index - 1].spentCents;
    bucket.change = { comparable: true, deltaCents, direction: deltaCents < 0 ? "less" : deltaCents > 0 ? "more" : "same" };
  });
  return { unit, buckets };
}
