"use client";

import Link from "next/link";
import { ArrowUp, Check, CircleMinus, Clock } from "lucide-react";
import type { PnlCell as Cell, PnlPeriod } from "@dollas/domain";
import { MoneyAmount } from "@/components/app/money-amount";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TableCell } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { activityHref, dollars, expenseCellDisplay, type CellDisplay, type CellIcon, type CellTone } from "./pnl-format";

const ICONS: Record<CellIcon, typeof Check> = { check: Check, up: ArrowUp, clock: Clock, minus: CircleMinus };

/** Fill per state. Finished periods: sage tint under, error tint over. The current period is hatched. */
function fill(tone: CellTone, kind: PnlPeriod["kind"]): string {
  if (tone === "under") return "bg-secondary";
  if (tone === "over") return "bg-error-tint";
  if (tone === "so_far_over") return "pnl-so-far-over";
  if (kind === "so_far") return "pnl-so-far";
  return "";
}

const subTone: Record<CellTone, string> = {
  under: "text-secondary-foreground",
  over: "text-over",
  so_far: "text-foreground",
  so_far_over: "text-over",
  unbudgeted: "text-muted-foreground",
  none: "text-muted-foreground",
  plain: "text-muted-foreground",
};

/** The amount, the signed word with its icon, and (with Show budgets) the budget line. */
export function PnlCellBody({
  cents,
  display,
  budgetLine,
  currency,
  className,
}: {
  cents: number;
  display: CellDisplay;
  budgetLine: string | null;
  currency: string;
  className?: string;
}) {
  if (display.tone === "none") return <span className={cn("grid justify-items-end text-muted-foreground", className)}>{"\u2014"}</span>;
  const Icon = display.icon ? ICONS[display.icon] : null;
  return (
    <span className={cn("grid justify-items-end gap-0.5", className)}>
      <MoneyAmount cents={cents} format={(value) => dollars(value, currency)} className="text-base leading-tight font-semibold" />
      {display.text ? (
        <span className={cn("inline-flex items-center justify-end gap-1 text-right text-xs leading-tight font-extrabold", subTone[display.tone])}>
          {Icon ? <Icon aria-hidden="true" className="size-3.5 stroke-[3]" /> : null}
          {display.text}
        </span>
      ) : null}
      {budgetLine ? <span className="text-xs leading-tight font-semibold whitespace-nowrap text-muted-foreground">{budgetLine}</span> : null}
    </span>
  );
}

/**
 * PnlCell: one category in one period. Picks its state from the cell and the period kind, and the
 * whole cell is a 48px button that opens Spent / Budget / Difference with a link to the activity.
 */
export function PnlCell({
  cell,
  period,
  name,
  categoryId,
  periodName,
  showBudgets,
  currency,
  today,
}: {
  cell: Cell;
  period: PnlPeriod;
  name: string;
  categoryId: string;
  periodName: string;
  showBudgets: boolean;
  currency: string;
  today: string;
}) {
  const display = expenseCellDisplay(cell, period.kind, name, periodName, currency);
  const budgetLine =
    showBudgets && cell.budgetCents !== null && period.kind !== "total"
      ? `of ${dollars(cell.budgetCents, currency)}${period.kind === "so_far" ? " month" : ""}`
      : null;
  const difference =
    cell.budgetCents === null
      ? "No budget"
      : period.kind === "so_far" && !cell.overAlready
        ? "Not compared until it ends"
        : display.text;
  if (display.tone === "none") {
    return (
      <TableCell className={cn("h-16 px-2 py-2 text-right", fill(display.tone, period.kind))}>
        <span className="sr-only">{display.spoken}</span>
        <PnlCellBody cents={0} display={display} budgetLine={null} currency={currency} className="min-h-12 content-center" />
      </TableCell>
    );
  }
  return (
    <TableCell className={cn("h-16 p-0 text-right", fill(display.tone, period.kind))}>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            aria-label={display.spoken}
            className="h-auto min-h-12 w-full justify-end rounded-none px-2 py-2 font-body font-normal whitespace-normal focus-visible:outline-offset-[-3px]"
          >
            <PnlCellBody cents={cell.actualCents} display={display} budgetLine={budgetLine} currency={currency} />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="grid gap-2">
          <h4 className="font-heading text-base">
            {name} · {periodName}
          </h4>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
            <dt>Spent</dt>
            <dd className="text-right tabular-nums">{dollars(cell.actualCents, currency)}</dd>
            <dt>Budget</dt>
            <dd className="text-right tabular-nums">{cell.budgetCents === null ? "None" : dollars(cell.budgetCents, currency)}</dd>
            <dt>Difference</dt>
            <dd className="text-right font-bold">{difference}</dd>
          </dl>
          <Button asChild variant="secondary" size="sm">
            <Link href={activityHref(categoryId, period, today)}>See {name} activity</Link>
          </Button>
        </PopoverContent>
      </Popover>
    </TableCell>
  );
}
