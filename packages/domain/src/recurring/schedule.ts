/**
 * When a recurring item is expected (PEN-206). Pure civil-date math on
 * `YYYY-MM-DD` strings in UTC, so time zones and DST never shift a day.
 *
 * - weekly / biweekly: the anchor date plus whole multiples of 7 or 14 days.
 * - monthly / quarterly / yearly: every 1, 3, or 12 months counted from the
 *   anchor's month, on `dayOfMonth` (or the anchor's day). A day past the end
 *   of a month is clamped: the 31st is the 30th in April, the 28th in
 *   February, and the 29th in a leap-year February.
 * - semimonthly (twice a month): every month on `dayOfMonth` (or the anchor's
 *   day) and `secondDayOfMonth`, each clamped the same way. If both clamp to
 *   the same day (30th and 31st in February) that month has one occurrence.
 *
 * Occurrences never fall before `startDate` or after `endDate`.
 */
export const CADENCES = ["weekly", "biweekly", "semimonthly", "monthly", "quarterly", "yearly"] as const;
export type Cadence = (typeof CADENCES)[number];

export const CADENCE_LABELS: Record<Cadence, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  semimonthly: "Twice a month",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
};

export type RecurringSchedule = {
  cadence: Cadence;
  /** One known occurrence; the pattern repeats forward and backward from it. */
  anchorDate: string;
  /** For month-based cadences: the intended day (1-31), so "the 31st" survives short months. Null uses the anchor's day. */
  dayOfMonth: number | null;
  /** Twice a month only: the second day (1-31). */
  secondDayOfMonth: number | null;
  startDate: string;
  endDate: string | null;
};

const MAX_OCCURRENCES = 2_000;

export function isCadence(value: string): value is Cadence {
  return (CADENCES as readonly string[]).includes(value);
}

/** Whether `value` is a real YYYY-MM-DD calendar date. */
export function isCivilDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function dayNumber(value: string): number {
  return Math.round(Date.parse(`${value}T00:00:00Z`) / 86_400_000);
}

export function fromDayNumber(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

export function addDays(value: string, days: number): string {
  return fromDayNumber(dayNumber(value) + days);
}

export function daysBetween(a: string, b: string): number {
  return Math.abs(dayNumber(a) - dayNumber(b));
}

function ymd(value: string): [number, number, number] {
  const [y, m, d] = value.split("-").map(Number);
  return [y, m, d];
}

function civil(year: number, month: number, day: number): string {
  const clamped = Math.min(day, daysInMonth(year, month));
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(clamped).padStart(2, "0")}`;
}

/** Monthly index (year * 12 + month - 1) for stepping by months. */
function monthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}

/** Every expected date from `from` to `to`, inclusive, in order. */
export function occurrencesBetween(schedule: RecurringSchedule, from: string, to: string): string[] {
  const lower = from > schedule.startDate ? from : schedule.startDate;
  const upper = schedule.endDate && schedule.endDate < to ? schedule.endDate : to;
  if (!isCivilDate(lower) || !isCivilDate(upper) || !isCivilDate(schedule.anchorDate) || lower > upper) return [];
  const out: string[] = [];
  if (schedule.cadence === "weekly" || schedule.cadence === "biweekly") {
    const step = schedule.cadence === "weekly" ? 7 : 14;
    const anchor = dayNumber(schedule.anchorDate);
    const first = anchor + Math.ceil((dayNumber(lower) - anchor) / step) * step;
    for (let day = first; day <= dayNumber(upper) && out.length < MAX_OCCURRENCES; day += step) out.push(fromDayNumber(day));
    return out;
  }
  const [anchorYear, anchorMonth, anchorDay] = ymd(schedule.anchorDate);
  const primary = schedule.dayOfMonth ?? anchorDay;
  const step = schedule.cadence === "quarterly" ? 3 : schedule.cadence === "yearly" ? 12 : 1;
  const anchorIndex = monthIndex(anchorYear, anchorMonth);
  const [lowYear, lowMonth] = ymd(lower);
  const [highYear, highMonth] = ymd(upper);
  const lowIndex = monthIndex(lowYear, lowMonth);
  let index = anchorIndex + Math.ceil((lowIndex - anchorIndex) / step) * step;
  for (; index <= monthIndex(highYear, highMonth) && out.length < MAX_OCCURRENCES; index += step) {
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    const days = schedule.cadence === "semimonthly" ? [primary, schedule.secondDayOfMonth ?? primary] : [primary];
    const dates = [...new Set(days.map((day) => civil(year, month, day)))].sort();
    for (const date of dates) if (date >= lower && date <= upper) out.push(date);
  }
  return out;
}

/** The next `count` expected dates on or after `onOrAfter`. */
export function nextOccurrences(schedule: RecurringSchedule, onOrAfter: string, count: number): string[] {
  if (count <= 0) return [];
  const spanDays = { weekly: 7, biweekly: 14, semimonthly: 16, monthly: 31, quarterly: 92, yearly: 366 }[schedule.cadence];
  return occurrencesBetween(schedule, onOrAfter, addDays(onOrAfter, spanDays * (count + 1))).slice(0, count);
}

/** The latest expected date on or before `onOrBefore`, or null. */
export function previousOccurrence(schedule: RecurringSchedule, onOrBefore: string): string | null {
  const spanDays = { weekly: 7, biweekly: 14, semimonthly: 16, monthly: 31, quarterly: 92, yearly: 366 }[schedule.cadence];
  const found = occurrencesBetween(schedule, addDays(onOrBefore, -spanDays * 2), onOrBefore);
  return found[found.length - 1] ?? null;
}

/** Roughly how many days apart occurrences are; used for windows and suggestion bands. */
export function cadencePeriodDays(cadence: Cadence): number {
  return { weekly: 7, biweekly: 14, semimonthly: 15, monthly: 30, quarterly: 91, yearly: 365 }[cadence];
}
