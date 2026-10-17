import { describe, expect, it } from "vitest";
import { buildProfitLoss, PNL_MAX_MONTHS, type PnlBudget, type PnlCategory, type PnlSplit, type PnlStore } from "./profit-loss";

const H = "h1";
const cat = (id: string, kind: string, extra: Partial<PnlCategory> = {}): PnlCategory => ({
  id, householdId: H, name: id, kind, sortOrder: 0, groupId: "g1", groupName: "Home", groupSort: 0, ...extra,
});
const categories = [
  cat("rent", "expense"),
  cat("food", "expense", { groupId: "g2", groupName: "Daily", groupSort: 1 }),
  cat("misc", "expense", { groupId: null, groupName: null, groupSort: null }),
  cat("pay", "income", { groupId: "g3", groupName: "Work", groupSort: 2 }),
  cat("xfer", "transfer", { groupId: null, groupName: null, groupSort: null }),
  cat("alien", "expense", { householdId: "other" }),
];

function store(splits: PnlSplit[], budgets: PnlBudget[] = [], cats = categories): PnlStore {
  return {
    async listCategories(h) { return cats.filter((c) => c.householdId === h); },
    async listBudgets(_h, r) {
      const lo = r.from.year * 12 + r.from.month, hi = r.to.year * 12 + r.to.month;
      return budgets.filter((b) => b.year * 12 + b.month >= lo && b.year * 12 + b.month <= hi);
    },
    async listSplits(_h, r) { return splits.filter((s) => s.occurredOn >= r.start && s.occurredOn <= r.end); },
  };
}
const s = (categoryId: string, amountCents: number, occurredOn: string): PnlSplit => ({ categoryId, kind: "x", amountCents, occurredOn });
const b = (categoryId: string, year: number, month: number, amountCents: number): PnlBudget => ({ categoryId, year, month, amountCents });
const asOf = { year: 2026, month: 10, day: 17 };
async function run(st: PnlStore, o: Partial<{ from: string; to: string; g: "month" | "quarter" | "ytd" }> = {}) {
  const r = await buildProfitLoss(st, { householdId: H, fromMonth: o.from ?? "2026-01", toMonth: o.to ?? "2026-03", granularity: o.g ?? "month", asOf });
  if (r.isErr()) throw r.error;
  return r.value;
}
const row = (r: Awaited<ReturnType<typeof run>>, id: string) => r.groups.flatMap((g) => g.categories).find((c) => c.id === id);

describe("profit and loss", () => {
  it("at budget is under, over is over, no budget is neutral", async () => {
    const r = await run(store(
      [s("rent", -100000, "2026-01-05"), s("rent", -100001, "2026-02-05"), s("food", -5000, "2026-01-09")],
      [b("rent", 2026, 1, 100000), b("rent", 2026, 2, 100000)],
    ));
    expect(row(r, "rent")!.periods.map((p) => p.status)).toEqual(["under", "over", "neutral"]);
    expect(row(r, "rent")!.periods[0]).toMatchObject({ actualCents: 100000, budgetCents: 100000, deltaCents: 0 });
    expect(row(r, "rent")!.periods[2]).toMatchObject({ actualCents: 0, budgetCents: null, deltaCents: null });
    expect(row(r, "food")!.periods[0]).toMatchObject({ actualCents: 5000, budgetCents: null, status: "neutral" });
  });

  it("income is actual-only; totals net; budget totals only where budgeted", async () => {
    const r = await run(store(
      [s("pay", 300000, "2026-01-15"), s("rent", -100000, "2026-01-05"), s("food", -5000, "2026-01-09")],
      [b("rent", 2026, 1, 90000), b("pay", 2026, 1, 999)],
    ));
    expect(row(r, "pay")!.periods[0]).toMatchObject({ actualCents: 300000, budgetCents: null, status: "neutral" });
    expect(r.totals[0]).toEqual({ incomeCents: 300000, expensesCents: 105000, netCents: 195000, budgetExpensesCents: 90000, budgetedActualCents: 100000, expensesDeltaCents: 15000, expensesStatus: "over", expensesOverAlready: false });
    expect(r.totals[1]).toEqual({ incomeCents: 0, expensesCents: 0, netCents: 0, budgetExpensesCents: null, budgetedActualCents: 0, expensesDeltaCents: null, expensesStatus: "neutral", expensesOverAlready: false });
  });

  it("excludes transfers and other households", async () => {
    const r = await run(store([s("xfer", -50000, "2026-01-02"), s("xfer", 50000, "2026-01-02"), s("alien", -7, "2026-01-02")]));
    expect(row(r, "xfer")).toBeUndefined();
    expect(row(r, "alien")).toBeUndefined();
    expect(r.groups).toEqual([]);
    expect(r.totals.every((t) => t.expensesCents === 0 && t.incomeCents === 0)).toBe(true);
  });

  it("refunds are negative: they reduce spending, even below zero; income reversals reduce income", async () => {
    const r = await run(store([s("food", -3000, "2026-01-02"), s("food", 1000, "2026-01-03"), s("food", 500, "2026-02-03"), s("pay", -200, "2026-01-04"), s("pay", 1000, "2026-01-04")]));
    expect(row(r, "food")!.periods.map((p) => p.actualCents)).toEqual([2000, -500, 0]);
    expect(r.totals[1].expensesCents).toBe(-500);
    expect(row(r, "pay")!.periods[0].actualCents).toBe(800);
  });

  it("groups in household order, ungrouped last, income and expense mix inside a group", async () => {
    const r = await run(store([s("misc", -1, "2026-01-02"), s("pay", 5, "2026-01-02"), s("food", -1, "2026-01-02"), s("rent", -1, "2026-01-02")]));
    expect(r.groups.map((g) => g.name)).toEqual(["Home", "Daily", "Work", "Ungrouped"]);
    const mixed = await buildProfitLoss(store([s("pay", 5, "2026-01-02"), s("rent", -1, "2026-01-02")], [], [cat("rent", "expense"), cat("pay", "income")]), { householdId: H, fromMonth: "2026-01", toMonth: "2026-01", granularity: "month", asOf });
    expect(mixed._unsafeUnwrap().groups[0].categories.map((c) => [c.id, c.kind])).toEqual([["pay", "income"], ["rent", "expense"]]);
  });

  it("quarters sum actuals and the budgets that exist; edges are clipped", async () => {
    const r = await run(store(
      [s("rent", -100, "2026-02-01"), s("rent", -100, "2026-03-31"), s("rent", -50, "2026-04-01"), s("rent", -1, "2026-07-01")],
      [b("rent", 2026, 2, 100), b("rent", 2026, 3, 100), b("rent", 2026, 4, 40)],
    ), { from: "2026-02", to: "2026-05", g: "quarter" });
    expect(r.periods.map((p) => [p.key, p.from, p.to, p.months])).toEqual([["2026-Q1", "2026-02", "2026-03", 2], ["2026-Q2", "2026-04", "2026-05", 2]]);
    expect(row(r, "rent")!.periods[0]).toMatchObject({ actualCents: 200, budgetCents: 200, budgetedMonths: 2, status: "under" });
    expect(row(r, "rent")!.periods[1]).toMatchObject({ actualCents: 50, budgetCents: 40, budgetedMonths: 1, status: "over" });
  });

  it("a partly budgeted quarter sums only the budgeted months", async () => {
    const r = await run(store([s("rent", -100, "2026-01-01"), s("rent", -100, "2026-02-01")], [b("rent", 2026, 1, 150)]), { g: "quarter" });
    expect(row(r, "rent")!.periods[0]).toMatchObject({ actualCents: 200, budgetCents: 150, budgetedMonths: 1, status: "over" });
  });

  it("ytd starts in January and resets each year", async () => {
    const r = await run(store(
      [s("food", -1, "2025-01-10"), s("food", -2, "2025-12-31"), s("food", -4, "2026-02-01"), s("food", -8, "2026-05-01")],
    ), { from: "2025-06", to: "2026-03", g: "ytd" });
    expect(r.from).toBe("2025-01");
    expect(r.periods.map((p) => [p.key, p.label, p.from, p.to])).toEqual([["2025-ytd", "2025", "2025-01", "2025-12"], ["2026-ytd", "2026 YTD", "2026-01", "2026-03"]]);
    expect(row(r, "food")!.periods.map((p) => p.actualCents)).toEqual([3, 4]);
  });

  it("the current month counts through today only and is flagged partial", async () => {
    const r = await run(store([s("food", -1, "2026-10-17"), s("food", -5, "2026-10-18")]), { from: "2026-09", to: "2026-10" });
    expect(row(r, "food")!.periods.map((p) => p.actualCents)).toEqual([0, 1]);
    expect(r.periods.map((p) => p.partial)).toEqual([false, true]);
  });

  it("empty months still appear with zeros", async () => {
    const r = await run(store([]), { from: "2026-01", to: "2026-03" });
    expect(r.periods).toHaveLength(3);
    expect(r.groups).toEqual([]);
    expect(r.totals).toHaveLength(3);
  });

  it("validates input", async () => {
    const st = store([]);
    const bad = (o: Parameters<typeof run>[1]) => buildProfitLoss(st, { householdId: H, fromMonth: o?.from ?? "2026-01", toMonth: o?.to ?? "2026-03", granularity: o?.g ?? "month", asOf });
    expect((await bad({ from: "2026-04", to: "2026-03" })).isErr()).toBe(true);
    expect((await bad({ from: "2026-1" })).isErr()).toBe(true);
    expect((await bad({ g: "week" as never })).isErr()).toBe(true);
    expect((await bad({ from: "2023-10", to: "2026-10" })).isErr()).toBe(true);
    expect((await bad({ from: "2023-10", to: "2026-10", g: "quarter" })).isErr()).toBe(true);
    expect((await bad({ from: "2023-11", to: "2026-10" })).isOk()).toBe(true);
    expect(PNL_MAX_MONTHS).toBe(36);
  });

  describe("current month (so far) and year to date", () => {
    const spend = [
      s("rent", -100, "2026-08-02"), s("rent", -100, "2026-09-02"), s("rent", -90, "2026-10-05"),
      s("food", -30, "2026-09-02"), s("food", -10, "2026-10-05"), s("pay", 500, "2026-10-01"),
    ];
    const budgets = [b("rent", 2026, 8, 100), b("rent", 2026, 9, 100), b("rent", 2026, 10, 100), b("food", 2026, 9, 50), b("food", 2026, 10, 20)];

    it("the current month is neutral until spending passes the full budget, then over already", async () => {
      const calm = await run(store(spend, budgets), { from: "2026-09", to: "2026-10" });
      expect(row(calm, "rent")!.periods.map((p) => [p.status, p.overAlready])).toEqual([["under", false], ["neutral", false]]);
      const over = await run(store([...spend, s("rent", -11, "2026-10-09")], budgets), { from: "2026-09", to: "2026-10" });
      expect(row(over, "rent")!.periods[1]).toMatchObject({ actualCents: 101, budgetCents: 100, deltaCents: 1, status: "over", overAlready: true });
      expect(row(over, "rent")!.periods[0].overAlready).toBe(false);
      expect(over.periods.map((p) => p.kind)).toEqual(["full", "so_far"]);
    });

    it("ytd through the current month is finished months, this month, and an actual-only total", async () => {
      const r = await run(store(spend, budgets), { from: "2026-03", to: "2026-10", g: "ytd" });
      expect(r.periods.map((p) => [p.key, p.label, p.from, p.to, p.kind, p.partial])).toEqual([
        ["2026-ytd-finished", "Jan to Sep", "2026-01", "2026-09", "full", false],
        ["2026-ytd-current", "Oct", "2026-10", "2026-10", "so_far", true],
        ["2026-ytd-total", "YTD total", "2026-01", "2026-10", "total", true],
      ]);
      expect(row(r, "rent")!.periods[0]).toMatchObject({ actualCents: 200, budgetCents: 200, status: "under" });
      expect(row(r, "rent")!.periods[1]).toMatchObject({ actualCents: 90, status: "neutral" });
      expect(row(r, "rent")!.periods[2]).toMatchObject({ actualCents: 290, budgetCents: null, deltaCents: null, status: "neutral", overAlready: false });
      expect(r.totals[2]).toMatchObject({ budgetExpensesCents: null, expensesStatus: "neutral", incomeCents: 500, expensesCents: 330 });
    });

    it("a quarter that ends in the current month is so far", async () => {
      const r = await run(store(spend, budgets), { from: "2026-07", to: "2026-10", g: "quarter" });
      expect(r.periods.map((p) => [p.key, p.kind])).toEqual([["2026-Q3", "full"], ["2026-Q4", "so_far"]]);
      expect(row(r, "rent")!.periods[0].status).toBe("under");
      expect(row(r, "rent")!.periods[1]).toMatchObject({ actualCents: 90, budgetCents: 100, status: "neutral" });
    });

    it("group subtotals and the expenses row compare total spend, unbudgeted included, with total budget", async () => {
      const r = await run(store([...spend, s("misc", -500, "2026-09-03")], budgets), { from: "2026-09", to: "2026-10" });
      const home = r.groups.find((g) => g.id === "g1")!;
      expect(home.expenseTotals[0]).toMatchObject({ actualCents: 100, budgetCents: 100, status: "under" });
      expect(r.totals[0]).toMatchObject({ expensesCents: 630, budgetExpensesCents: 150, expensesDeltaCents: 480, expensesStatus: "over" });
      expect(r.totals[1]).toMatchObject({ expensesStatus: "neutral", expensesOverAlready: false });
    });
  });
});
