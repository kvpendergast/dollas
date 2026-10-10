import { formatCents, type EstimatePace } from "@dollas/domain";

/** The daily pace in plain words, shared by Home's card and the Spend estimate page. */
export function describePace(pace: EstimatePace, currency: string): string {
  const money = (cents: number) => formatCents(cents, currency);
  if (pace.basis === "not_enough_history") {
    return "There isn't enough history yet to estimate everyday spending (about two weeks is needed), so this shows recurring items only.";
  }
  if (pace.basis === "pooled") {
    const days = pace.thisMonthDays + pace.trailingDays;
    return `About ${money(pace.dailyCents)} a day of everyday spending, based on your ${days} days of history.`;
  }
  return `About ${money(pace.dailyCents)} a day of everyday spending, based on this month so far (${money(pace.thisMonthDailyCents)} a day) and the ${pace.trailingDays} days before it (${money(pace.trailingDailyCents)} a day).`;
}

export function monthName(yyyyMm: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(`${yyyyMm}-01T00:00:00Z`));
}
