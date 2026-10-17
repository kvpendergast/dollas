"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronsRight, CircleMinus, Clock, Info } from "lucide-react";
import type { PnlCell as Cell, PnlGroup, PnlGranularity, PnlPeriod, ProfitLoss } from "@dollas/domain";
import { EmptyState } from "@/components/app/empty-state";
import { TableCard } from "@/components/app/table-card";
import { MoneyAmount } from "@/components/app/money-amount";
import { StatusPill } from "@/components/app/status-pill";
import { buttonVariants } from "@/components/ui/button";
import { Collapsible, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChoiceGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { PnlCell, PnlCellBody } from "./pnl-cell";
import { dollars, expenseCellDisplay, periodHeading, signedDollars } from "./pnl-format";

const GROUP_TONES = ["bg-amber", "bg-pink", "bg-sage-tint"] as const;
const STORAGE_KEY = "dollas.pnl.collapsed";
const GRANULARITY_OF = { months: "month", quarters: "quarter", ytd: "ytd" } as const;

const listeners = new Set<() => void>();
function subscribeCollapsed(callback: () => void) {
  listeners.add(callback);
  window.addEventListener("storage", callback);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", callback);
  };
}
function readCollapsed(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? "[]";
  } catch {
    return "[]";
  }
}
function parseCollapsed(raw: string): string[] {
  try {
    const saved = JSON.parse(raw) as unknown;
    return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export type PnlPeriodChoice = keyof typeof GRANULARITY_OF;

function cellFill(kind: PnlPeriod["kind"]): string {
  return kind === "so_far" ? "pnl-so-far" : "";
}

function SummaryCell({ cell, period, children, className }: { cell?: Cell; period: PnlPeriod; children: ReactNode; className?: string }) {
  void cell;
  return <TableCell className={cn("h-[72px] border-b-2 border-foreground px-2 py-2 text-right", cellFill(period.kind), className)}>{children}</TableCell>;
}

/**
 * The P&L screen body: period controls, the Show budgets switch, the table, the legend and the note.
 * Everything is derived from the shared get_profit_and_loss result (no money maths in here).
 */
export function PnlView({
  report,
  period,
  months,
  currency,
  today,
}: {
  report: ProfitLoss;
  period: PnlPeriodChoice;
  months: 6 | 12;
  currency: string;
  today: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [showBudgets, setShowBudgets] = useState(false);
  // Open/closed groups are remembered per device; the server render starts with every group open.
  const collapsedRaw = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => "[]");
  const collapsed = parseCollapsed(collapsedRaw);
  const [scrolled, setScrolled] = useState(false);
  const [more, setMore] = useState(false);
  const scroller = useRef<HTMLDivElement | null>(null);
  const granularity: PnlGranularity = GRANULARITY_OF[period];

  function update() {
    const el = scroller.current;
    if (!el) return;
    setScrolled(el.scrollLeft > 2);
    setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }
  // The table can move between the page and the full screen dialog; measure again when it lands.
  const measure = useCallback((el: HTMLDivElement | null) => {
    scroller.current = el;
    if (el) requestAnimationFrame(() => {
      setScrolled(el.scrollLeft > 2);
      setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
    });
  }, []);
  useEffect(() => {
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [report]);

  function go(next: { period?: string; months?: string }) {
    const params = new URLSearchParams();
    const p = next.period ?? period;
    if (p !== "months") params.set("period", p);
    const m = next.months ?? String(months);
    if (p === "months" && m === "12") params.set("months", "12");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  }

  function toggleGroup(id: string, open: boolean) {
    const next = open ? collapsed.filter((value) => value !== id) : [...collapsed, id];
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* private mode: the choice just is not remembered */
    }
    listeners.forEach((listener) => listener());
  }

  const { periods, totals } = report;
  const headings = periods.map((p) => periodHeading(p, granularity));
  const incomeRows = report.groups.flatMap((g) => g.categories.filter((c) => c.kind === "income"));
  const expenseGroups = report.groups.filter((g) => g.categories.some((c) => c.kind === "expense"));
  const minWidth = `calc(var(--pnl-first) + ${periods.length} * var(--pnl-col))`;
  const popToday = today;

  const toggles = (
    <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
      <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
        <ChoiceGroup value={period} onValueChange={(value) => go({ period: value })} aria-label="Period" className="sm:flex-none">
          <ToggleGroupItem value="months" className="whitespace-nowrap">Months</ToggleGroupItem>
          <ToggleGroupItem value="quarters" className="whitespace-nowrap">Quarters</ToggleGroupItem>
          <ToggleGroupItem value="ytd" className="whitespace-nowrap">Year to date</ToggleGroupItem>
        </ChoiceGroup>
        {period === "months" ? (
          <ChoiceGroup value={String(months)} onValueChange={(value) => go({ months: value })} aria-label="How many months" className="sm:flex-none">
            <ToggleGroupItem value="6" className="whitespace-nowrap">6 months</ToggleGroupItem>
            <ToggleGroupItem value="12" className="whitespace-nowrap">12 months</ToggleGroupItem>
          </ChoiceGroup>
        ) : null}
      </div>
      <div className="flex min-h-11 items-center gap-3">
        <Switch id="pnl-show-budgets" checked={showBudgets} onCheckedChange={setShowBudgets} />
        <Label htmlFor="pnl-show-budgets" className="cursor-pointer text-sm font-semibold">
          Show budgets
        </Label>
      </div>
    </div>
  );

  if (report.groups.length === 0) {
    return (
      <div className="space-y-4">
        {toggles}
        <EmptyState
          title="Nothing to compare yet"
          body="Once you have a full month of activity and a plan, each month shows up here with income, spending and what is left over."
          href="/plan"
          action="Set up your plan"
          extra={
            <Link href="/activity" className={buttonVariants({ variant: "outline", size: "sm" })}>
              Add activity
            </Link>
          }
        />
        <p className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <Info aria-hidden="true" className="size-4" /> Transfers are not included.
        </p>
      </div>
    );
  }

  const groupHeader = (id: string, name: string, tone: string, open: boolean, cells: ReactNode) => (
    <TableRow className="border-b-2 border-foreground">
      <TableHead scope="rowgroup" className={cn("sticky left-0 z-[2] h-[52px] border-r-2 border-foreground p-0", tone, scrolled && "shadow-[6px_0_8px_-4px_color-mix(in_oklab,var(--foreground)_28%,transparent)]")}>
        <CollapsibleTrigger className="h-[52px] gap-2 px-3 font-heading text-base font-extrabold" aria-label={`${name}, ${open ? "collapse" : "expand"}`}>
          <span className="flex min-w-0 items-center gap-2">
            <ChevronDown aria-hidden="true" className={cn("size-4 shrink-0 stroke-[3] transition-transform duration-(--motion-base)", !open && "-rotate-90")} />
            <span className="truncate">{name}</span>
          </span>
        </CollapsibleTrigger>
      </TableHead>
      {cells}
    </TableRow>
  );

  const groupCells = (tone: string, render: (b: number) => ReactNode) =>
    periods.map((p, b) => (
      <TableCell key={p.key} className={cn("h-[52px] px-2 py-1 text-right", tone)}>
        {render(b)}
      </TableCell>
    ));

  function renderExpenseGroup(group: PnlGroup, index: number) {
    const open = !collapsed.includes(group.id);
    const tone = GROUP_TONES[index % GROUP_TONES.length];
    const rows = group.categories.filter((c) => c.kind === "expense");
    return (
      <Collapsible key={group.id} asChild open={open} onOpenChange={(next) => toggleGroup(group.id, next)}>
        <TableBody className="data-[state=closed]:[&_tr[data-cat]]:hidden">
          {groupHeader(
            group.id,
            group.name,
            tone,
            open,
            groupCells(tone, (b) => {
              const cell = group.expenseTotals[b];
              const display = expenseCellDisplay(cell, periods[b].kind, group.name, headings[b].long, currency);
              return <PnlCellBody cents={cell.actualCents} display={display} budgetLine={null} currency={currency} className="text-sm" />;
            }),
          )}
          {rows.map((row) => (
            <TableRow key={row.id} data-cat className="border-b-2 border-dashed border-border-soft">
              <TableHead scope="row" className="sticky left-0 z-[2] h-16 border-r-2 border-foreground bg-card px-2 py-2 text-sm font-bold whitespace-normal sm:px-3 sm:text-[0.9375rem]">
                <span className="block pl-1.5">
                  {row.name}
                  {row.periods.every((cell) => cell.budgetCents === null) ? <span className="block text-xs font-bold text-muted-foreground">Unbudgeted</span> : null}
                </span>
              </TableHead>
              {periods.map((p, b) => (
                <PnlCell
                  key={p.key}
                  cell={row.periods[b]}
                  period={p}
                  name={row.name}
                  categoryId={row.id}
                  periodName={headings[b].long}
                  showBudgets={showBudgets}
                  currency={currency}
                  today={popToday}
                />
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Collapsible>
    );
  }

  const incomeOpen = !collapsed.includes("income");
  const stickyFirst = cn("sticky left-0 z-[2] border-r-2 border-foreground", scrolled && "shadow-[6px_0_8px_-4px_color-mix(in_oklab,var(--foreground)_28%,transparent)]");

  const tableBody = (fullscreen: boolean) => (
      <div className={cn("relative", fullscreen && "h-full")}>
        <Table
          containerProps={{
            ref: measure,
            tabIndex: 0,
            role: "region",
            "aria-label": "Profit and loss table. Scroll sideways for more columns.",
            onScroll: update,
            className: cn(fullscreen && "h-full overflow-auto", "overscroll-x-contain focus-visible:outline-3 focus-visible:-outline-offset-3 focus-visible:outline-ring [--pnl-first:132px] [--pnl-col:112px] sm:[--pnl-first:208px] sm:[--pnl-col:104px]"),
          }}
          className="table-fixed border-separate border-spacing-0"
          style={{ minWidth }}
        >
          <TableCaption className="sr-only">
            Profit and loss by {period === "months" ? "month" : period === "quarters" ? "quarter" : "year to date"}. Each cell shows what was spent and how it compares with the budget.
          </TableCaption>
          <colgroup>
            <col style={{ width: "var(--pnl-first)" }} />
            {periods.map((p) => (
              <col key={p.key} />
            ))}
          </colgroup>
          <TableHeader className={cn("bg-card", fullscreen && "[&_th]:sticky [&_th]:top-0 [&_th]:bg-card")}>
            <TableRow className="border-b-0">
              <TableHead scope="col" className={cn("border-b-2 border-foreground bg-card px-3 py-3 font-heading text-xs tracking-wider uppercase", stickyFirst, "z-[4]")}>
                Category
              </TableHead>
              {periods.map((p, b) => (
                <TableHead key={p.key} scope="col" className="border-b-2 border-foreground px-2 py-3 text-right align-bottom font-heading text-xs tracking-wider uppercase">
                  <span className="block">{headings[b].short}</span>
                  {p.kind === "so_far" ? (
                    <span className="mt-1.5 flex justify-end">
                      <StatusPill status="sofar" />
                    </span>
                  ) : null}
                  {headings[b].sub ? (
                    <span className="mt-1.5 flex justify-end">
                      <StatusPill status="sofar" label={headings[b].sub ?? undefined} />
                    </span>
                  ) : null}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>

          <TableBody>
            <TableRow>
              <TableHead scope="row" className={cn("h-[72px] border-b-2 border-foreground bg-secondary px-3 font-heading text-[1.05rem] font-extrabold", stickyFirst)}>Income</TableHead>
              {periods.map((p, b) => (
                <SummaryCell key={p.key} period={p}>
                  <MoneyAmount cents={totals[b].incomeCents} format={(value) => dollars(value, currency)} className="text-lg font-semibold" />
                </SummaryCell>
              ))}
            </TableRow>
            <TableRow>
              <TableHead scope="row" className={cn("h-[72px] border-b-2 border-foreground bg-secondary px-3 font-heading text-[1.05rem] font-extrabold", stickyFirst)}>Expenses</TableHead>
              {periods.map((p, b) => {
                const t = totals[b];
                const cell: Cell = {
                  actualCents: t.expensesCents,
                  budgetCents: t.budgetExpensesCents,
                  deltaCents: t.expensesDeltaCents,
                  budgetedMonths: 0,
                  status: t.expensesStatus,
                  overAlready: t.expensesOverAlready,
                };
                const display = expenseCellDisplay(cell, p.kind, "Expenses", headings[b].long, currency);
                const tint = display.tone === "under" ? "bg-secondary" : display.tone === "over" ? "bg-error-tint" : display.tone === "so_far_over" ? "pnl-so-far-over" : "";
                return (
                  <SummaryCell key={p.key} period={p} className={tint}>
                    <span className="sr-only">{display.spoken}</span>
                    <PnlCellBody
                      cents={t.expensesCents}
                      display={display}
                      budgetLine={showBudgets && t.budgetExpensesCents !== null && p.kind !== "total" ? `of ${dollars(t.budgetExpensesCents, currency)}${p.kind === "so_far" ? " month" : ""}` : null}
                      currency={currency}
                    />
                  </SummaryCell>
                );
              })}
            </TableRow>
            <TableRow>
              <TableHead scope="row" className={cn("h-[72px] border-b-2 border-foreground bg-secondary px-3 font-heading text-[1.05rem] font-extrabold", stickyFirst)}>Net</TableHead>
              {periods.map((p, b) => {
                const net = totals[b].netCents;
                const ahead = net >= 0;
                const tint = p.kind === "full" ? (ahead ? "bg-secondary" : "bg-error-tint") : "";
                return (
                  <SummaryCell key={p.key} period={p} className={tint}>
                    <span className="sr-only">{`Net, ${headings[b].long}: ${signedDollars(net, currency)}${p.kind === "full" ? (ahead ? " left over" : " short") : ""}`}</span>
                    <span aria-hidden="true" className="grid justify-items-end gap-0.5">
                      <span className="text-lg leading-tight font-semibold tabular-nums">{signedDollars(net, currency)}</span>
                      {p.kind === "full" ? (
                        <span className={cn("inline-flex items-center gap-1 text-xs font-extrabold", ahead ? "text-secondary-foreground" : "text-over")}>
                          {ahead ? <ArrowUp className="size-3.5 stroke-[3]" /> : <ArrowDown className="size-3.5 stroke-[3]" />}
                          {ahead ? "Left over" : "Short"}
                        </span>
                      ) : p.kind === "so_far" ? (
                        <span className="inline-flex items-center gap-1 text-xs font-extrabold">
                          <Clock className="size-3.5 stroke-[3]" />
                          so far
                        </span>
                      ) : null}
                    </span>
                  </SummaryCell>
                );
              })}
            </TableRow>
          </TableBody>

          {incomeRows.length > 0 ? (
            <Collapsible asChild open={incomeOpen} onOpenChange={(next) => toggleGroup("income", next)}>
              <TableBody className="data-[state=closed]:[&_tr[data-cat]]:hidden">
                {groupHeader(
                  "income",
                  "Income",
                  "bg-mint",
                  incomeOpen,
                  groupCells("bg-mint", (b) => (
                    <MoneyAmount cents={totals[b].incomeCents} format={(value) => dollars(value, currency)} className="text-[0.9375rem] font-semibold" />
                  )),
                )}
                {incomeRows.map((row) => (
                  <TableRow key={row.id} data-cat className="border-b-2 border-dashed border-border-soft">
                    <TableHead scope="row" className="sticky left-0 z-[2] h-16 border-r-2 border-foreground bg-card px-2 py-2 text-sm font-bold whitespace-normal sm:px-3 sm:text-[0.9375rem]">
                      <span className="block pl-1.5">{row.name}</span>
                    </TableHead>
                    {periods.map((p, b) => (
                      <TableCell key={p.key} className={cn("h-16 px-2 py-2 text-right", cellFill(p.kind))}>
                        <span className="sr-only">{`${row.name}, ${headings[b].long}: ${dollars(row.periods[b].actualCents, currency)} received`}</span>
                        <MoneyAmount cents={row.periods[b].actualCents} format={(value) => dollars(value, currency)} className="text-base font-semibold" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Collapsible>
          ) : null}

          {expenseGroups.map((group, index) => renderExpenseGroup(group, index))}
        </Table>
        {more ? (
          <span aria-hidden="true" className="pointer-events-none absolute top-0 right-0 bottom-0 z-[3] w-9 bg-gradient-to-r from-transparent to-[color-mix(in_oklab,var(--foreground)_16%,transparent)]" />
        ) : null}
        {more ? (
          <p className="flex items-center gap-2 border-t-2 border-foreground bg-card px-3.5 py-2.5 text-[0.8125rem] font-bold sm:hidden">
            <ChevronsRight aria-hidden="true" className="size-4" /> Swipe sideways for more columns
          </p>
        ) : null}
      </div>
  );

  return (
    <div className="space-y-4">
      <TableCard title="Profit and loss" controls={toggles}>
        {({ fullscreen }) => tableBody(fullscreen)}
      </TableCard>

      <ul aria-label="How to read the table" className="m-0 flex list-none flex-wrap gap-x-4 gap-y-2 p-0 text-[0.8125rem] font-bold">
        <Legend icon={<Check aria-hidden="true" className="size-3.5 stroke-[3]" />} tone="bg-secondary" label="Under or on budget" />
        <Legend icon={<ArrowUp aria-hidden="true" className="size-3.5 stroke-[3] text-over" />} tone="bg-error-tint" label="Over budget" />
        <Legend icon={<CircleMinus aria-hidden="true" className="size-3.5 stroke-[3]" />} tone="bg-card" label="Unbudgeted, no judgment" />
        <Legend icon={<Clock aria-hidden="true" className="size-3.5 stroke-[3]" />} tone="bg-amber" label="Month so far, not compared yet" />
      </ul>
      <p className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
        <Info aria-hidden="true" className="size-4" /> Transfers are not included.
      </p>
    </div>
  );
}

function Legend({ icon, tone, label }: { icon: ReactNode; tone: string; label: string }) {
  return (
    <li className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={cn("inline-grid size-6 place-items-center rounded-full border-2 border-foreground", tone)}>
        {icon}
      </span>
      {label}
    </li>
  );
}
