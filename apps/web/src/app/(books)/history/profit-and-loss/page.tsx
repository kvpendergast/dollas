import Link from "next/link";
import { ChevronLeft, Clock } from "lucide-react";
import { monthLabel, shortMonthLabel } from "@dollas/domain";
import { MoneyAmount } from "@/components/app/money-amount";
import { PageHeader } from "@/components/app/page-header";
import { StatCard } from "@/components/app/stat-card";
import { PnlView, type PnlPeriodChoice } from "@/components/pnl/pnl-view";
import { dollars, signedDollars } from "@/components/pnl/pnl-format";
import { Button } from "@/components/ui/button";
import { requireBooks } from "@/slices/access/guard";
import { loadProfitAndLoss } from "@/slices/plan/load";

export const metadata = { title: "Profit & loss" };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function monthText(year: number, month: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

function shift(year: number, month: number, delta: number): string {
  const total = year * 12 + (month - 1) + delta;
  return monthText(Math.floor(total / 12), (total % 12) + 1);
}

export default async function ProfitAndLossPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const books = await requireBooks();
  const params = await searchParams;
  const requested = first(params.period);
  const period: PnlPeriodChoice = requested === "quarters" || requested === "ytd" ? requested : "months";
  const months: 6 | 12 = first(params.months) === "12" ? 12 : 6;
  const { year, month, day } = books.asOf;
  const current = monthText(year, month);
  const januaryOfThisYear = monthText(year, 1);

  const granularity = period === "months" ? "month" : period === "quarters" ? "quarter" : "ytd";
  const [report, strip] = await Promise.all([
    loadProfitAndLoss(books, {
      fromMonth: period === "months" ? shift(year, month, -(months - 1)) : januaryOfThisYear,
      toMonth: current,
      granularity,
    }),
    loadProfitAndLoss(books, { fromMonth: current, toMonth: current, granularity: "month" }),
  ]);
  const now = strip.totals[0];
  const today = `${current}-${String(day).padStart(2, "0")}`;
  const openMonth = shortMonthLabel(year, month);
  const description = {
    months: "Month by month: what came in, what went out, and how each category did against its budget.",
    quarters: "Quarter by quarter. A quarter\u2019s budget is the sum of its monthly budgets.",
    ytd: `Since January. Finished months are compared with budget; ${monthLabel(year, month).split(" ")[0]} stays neutral until it ends.`,
  }[period];
  const format = (cents: number) => dollars(cents, books.currency);

  return (
    <div className="w-full space-y-6">
      <PageHeader
        title="Profit & loss"
        description={description}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/history">
              <ChevronLeft aria-hidden="true" /> Back to History
            </Link>
          </Button>
        }
      />
      <section aria-label={`${monthLabel(year, month)} so far`} className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
        <StatCard
          size="lg"
          className="col-span-2 bg-secondary sm:col-span-1"
          label="Net this month, so far"
          value={<MoneyAmount cents={now.netCents} format={(cents) => signedDollars(cents, books.currency)} />}
          note={
            <span className="inline-flex items-center gap-1.5 font-bold">
              <Clock aria-hidden="true" className="size-3.5 stroke-[3]" /> Income minus spending, {openMonth} 1 to {openMonth} {day}
            </span>
          }
        />
        <StatCard size="lg" label="Income" value={<MoneyAmount cents={now.incomeCents} format={format} />} />
        <StatCard size="lg" label="Expenses" value={<MoneyAmount cents={now.expensesCents} format={format} />} />
      </section>
      <PnlView report={report} period={period} months={months} currency={books.currency} today={today} />
    </div>
  );
}
