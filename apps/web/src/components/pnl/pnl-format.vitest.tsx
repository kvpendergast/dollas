import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { PnlCell, PnlPeriod, ProfitLoss } from "@dollas/domain";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }), usePathname: () => "/history/profit-and-loss" }));

import { PnlView } from "./pnl-view";
import { activityHref, dollars, expenseCellDisplay, signedDollars } from "./pnl-format";

const cell = (actual: number, budget: number | null, status: PnlCell["status"], over = false): PnlCell => ({
  actualCents: actual,
  budgetCents: budget,
  deltaCents: budget === null ? null : actual - budget,
  budgetedMonths: budget === null ? 0 : 1,
  status,
  overAlready: over,
});

describe("P&L cell wording (colour is never the only signal)", () => {
  it("says under, on budget and over with a signed word and an icon", () => {
    expect(expenseCellDisplay(cell(24100, 26000, "under"), "full", "Dining out", "Sep 2026")).toMatchObject({ tone: "under", icon: "check", text: "\u2212$19 under" });
    expect(expenseCellDisplay(cell(26000, 26000, "under"), "full", "Dining out", "Sep 2026")).toMatchObject({ tone: "under", text: "On budget" });
    expect(expenseCellDisplay(cell(27800, 26000, "over"), "full", "Dining out", "Sep 2026")).toMatchObject({ tone: "over", icon: "up", text: "+$18 over" });
  });
  it("keeps the current month neutral, except once it is over already", () => {
    expect(expenseCellDisplay(cell(10000, 26000, "neutral"), "so_far", "Dining out", "Oct 2026")).toMatchObject({ tone: "so_far", icon: "clock", text: "so far" });
    const over = expenseCellDisplay(cell(26600, 26000, "over", true), "so_far", "Dining out", "Oct 2026");
    expect(over).toMatchObject({ tone: "so_far_over", icon: "up", text: "+$6 over already" });
    expect(over.spoken).toContain("Already over");
  });
  it("shows unbudgeted spend as neutral, no spend as a dash, and totals as actual only", () => {
    expect(expenseCellDisplay(cell(31000, null, "neutral"), "full", "Vet visits", "Jul 2026")).toMatchObject({ tone: "unbudgeted", icon: "minus", text: "unbudgeted" });
    expect(expenseCellDisplay(cell(0, null, "neutral"), "full", "Vet visits", "Aug 2026").tone).toBe("none");
    expect(expenseCellDisplay(cell(29000, null, "neutral"), "total", "Rent", "YTD total")).toMatchObject({ tone: "plain", text: null });
  });
  it("formats whole dollars, keeps cents under a dollar, and uses a real minus", () => {
    expect(dollars(177300)).toBe("$1,773");
    expect(dollars(30)).toBe("$0.30");
    expect(signedDollars(-37400)).toBe("\u2212$374");
    expect(signedDollars(88600)).toBe("+$886");
    expect(signedDollars(0)).toBe("$0");
  });
  it("links a period to the matching activity, stopping at today for the open month", () => {
    const period = { key: "2026-10", label: "2026-10", from: "2026-10", to: "2026-10", months: 1, kind: "so_far", partial: true } satisfies PnlPeriod;
    const href = activityHref("c1", period, "2026-10-17");
    expect(href).toContain("from=2026-10-01");
    expect(href).toContain("to=2026-10-17");
    expect(href).toContain("category=c1");
  });
});

const periods: PnlPeriod[] = [
  { key: "2026-09", label: "2026-09", from: "2026-09", to: "2026-09", months: 1, kind: "full", partial: false },
  { key: "2026-10", label: "2026-10", from: "2026-10", to: "2026-10", months: 1, kind: "so_far", partial: true },
];
const report: ProfitLoss = {
  granularity: "month",
  from: "2026-09",
  to: "2026-10",
  periods,
  totals: [
    { incomeCents: 500000, expensesCents: 300000, netCents: 200000, budgetExpensesCents: 310000, budgetedActualCents: 300000, expensesDeltaCents: -10000, expensesStatus: "under", expensesOverAlready: false },
    { incomeCents: 400000, expensesCents: 100000, netCents: 300000, budgetExpensesCents: 90000, budgetedActualCents: 100000, expensesDeltaCents: 10000, expensesStatus: "over", expensesOverAlready: true },
  ],
  groups: [
    { id: "i", name: "Work", expenseTotals: [], categories: [{ id: "pay", name: "Paycheck", kind: "income", periods: [cell(500000, null, "neutral"), cell(400000, null, "neutral")] }] },
    {
      id: "f",
      name: "Food",
      expenseTotals: [cell(300000, 310000, "under"), cell(100000, 90000, "over", true)],
      categories: [{ id: "din", name: "Dining out", kind: "expense", periods: [cell(24100, 26000, "under"), cell(26600, 26000, "over", true)] }],
    },
  ],
};

describe("P&L screen", () => {
  it("renders a real table with text for every state and no colour-only result", () => {
    const html = renderToStaticMarkup(<PnlView report={report} period="months" months={6} currency="USD" today="2026-10-17" />);
    expect(html).toContain("<table");
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html).toContain('scope="rowgroup"');
    expect(html).toContain("\u2212$19 under");
    expect(html).toContain("+$6 over already");
    expect(html).toContain("Show budgets");
    expect(html).toContain("So far");
    expect(html).toContain("Transfers are not included.");
    expect(html).not.toMatch(/one-off|planned net/i);
  });
  it("shows an empty state when there is nothing to compare", () => {
    const html = renderToStaticMarkup(<PnlView report={{ ...report, groups: [] }} period="months" months={6} currency="USD" today="2026-10-17" />);
    expect(html).toContain("Nothing to compare yet");
    expect(html).toContain("Set up your plan");
  });
});
