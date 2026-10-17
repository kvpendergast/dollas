import type { PnlCell, PnlPeriod } from "@dollas/domain";

/** Whole dollars for the table. Amounts under a dollar keep their cents so a small miss never reads as "$0". */
export function dollars(cents: number, currency = "USD"): string {
  const abs = Math.abs(cents);
  const small = abs > 0 && abs < 100;
  const text = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: small ? 2 : 0,
    maximumFractionDigits: small ? 2 : 0,
  }).format(small ? abs / 100 : Math.round(abs / 100));
  return cents < 0 ? `\u2212${text}` : text;
}

/** "+$1,773" or "\u2212$374" (a real minus sign). Zero has no sign. */
export function signedDollars(cents: number, currency = "USD"): string {
  return cents > 0 ? `+${dollars(cents, currency)}` : dollars(cents, currency);
}

export type CellTone = "under" | "over" | "so_far" | "so_far_over" | "unbudgeted" | "none" | "plain";
export type CellIcon = "check" | "up" | "clock" | "minus";

export type CellDisplay = {
  tone: CellTone;
  icon: CellIcon | null;
  /** The signed word under the amount, e.g. "\u2212$42 under". Null when there is nothing to say. */
  text: string | null;
  /** Spoken label for the cell button, e.g. "Dining out, Sep 2026: $241 spent, budget $260, under by $19". */
  spoken: string;
};

/** What an expense cell says. Colour never carries the result alone: icon plus a signed word. */
export function expenseCellDisplay(cell: PnlCell, kind: PnlPeriod["kind"], name: string, period: string, currency = "USD"): CellDisplay {
  const spent = dollars(cell.actualCents, currency);
  if (cell.budgetCents === null) {
    if (cell.actualCents === 0) return { tone: "none", icon: null, text: null, spoken: `${name}, ${period}: nothing spent, no budget` };
    if (kind === "total") return { tone: "plain", icon: null, text: null, spoken: `${name}, ${period}: ${spent} spent` };
    return { tone: "unbudgeted", icon: "minus", text: "unbudgeted", spoken: `${name}, ${period}: ${spent} spent, no budget` };
  }
  const budget = dollars(cell.budgetCents, currency);
  const delta = cell.deltaCents ?? 0;
  if (kind === "so_far") {
    if (cell.overAlready) {
      return {
        tone: "so_far_over",
        icon: "up",
        text: `+${dollars(delta, currency)} over already`,
        spoken: `${name}, ${period}: ${spent} spent so far of ${budget} budget. Already over by ${dollars(delta, currency)}.`,
      };
    }
    return { tone: "so_far", icon: "clock", text: "so far", spoken: `${name}, ${period}: ${spent} spent so far of ${budget} budget. Not compared until the month ends.` };
  }
  if (delta > 0) return { tone: "over", icon: "up", text: `+${dollars(delta, currency)} over`, spoken: `${name}, ${period}: ${spent} spent, budget ${budget}, over by ${dollars(delta, currency)}` };
  if (delta === 0) return { tone: "under", icon: "check", text: "On budget", spoken: `${name}, ${period}: ${spent} spent, budget ${budget}, on budget` };
  return { tone: "under", icon: "check", text: `\u2212${dollars(-delta, currency)} under`, spoken: `${name}, ${period}: ${spent} spent, budget ${budget}, under by ${dollars(-delta, currency)}` };
}

/** "Sep 2026" from "2026-09". */
export function monthKeyLabel(key: string, withYear = true): string {
  const [year, month] = key.split("-").map(Number);
  const name = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
  return withYear ? `${name} ${year}` : name;
}

/** Column heading text and the longer spoken name for a period. */
export function periodHeading(period: PnlPeriod, granularity: "month" | "quarter" | "ytd"): { short: string; long: string; sub: string | null } {
  if (granularity === "month") return { short: monthKeyLabel(period.from, false), long: monthKeyLabel(period.from), sub: null };
  return { short: period.label, long: `${period.label}, ${period.from} to ${period.to}`, sub: period.kind === "total" ? `Includes ${monthKeyLabel(period.to, false)} so far` : null };
}

/** Where a category's activity for a period lives (Activity filtered by category and dates). */
export function activityHref(categoryId: string, period: PnlPeriod, today: string): string {
  const [year, month] = period.to.split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const end = `${period.to}-${String(last).padStart(2, "0")}`;
  const params = new URLSearchParams({ from: `${period.from}-01`, to: period.partial && end > today ? today : end, category: categoryId });
  return `/activity?${params.toString()}`;
}
