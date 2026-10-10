import { HistoryChart } from "@/components/history/history-chart";
import { SpendingDashboardView } from "@/components/spending/dashboard";
import { FilterBar } from "@/components/spending/filter-bar";
import { requireBooks } from "@/slices/access/guard";
import { loadHistory } from "@/slices/books/queries";
import { loadFilterContext } from "@/slices/spending/load";
import { getSpendingBreakdown } from "@/slices/spending/service";
import { NextStep } from "@/components/onboarding/next-step";
import { loadFirstUseFacts } from "@/slices/onboarding/service";

export default async function HistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const books = await requireBooks();
  const facts = await loadFirstUseFacts(books);
  if (!facts.hasTransactions) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="font-serif text-4xl">History</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">Where the money went, filtered any way you like, and month over month.</p>
        </div>
        <NextStep
          title="No history yet"
          body={
            facts.hasAccounts
              ? "History fills in from your transactions: totals, a trend, spending by category and account, and month over month. Add a few or import a CSV from your bank to start."
              : "History fills in from your transactions. Add an account first, then add transactions, import a CSV, or link a bank."
          }
          href={facts.hasAccounts ? "/activity" : "/accounts"}
          action={facts.hasAccounts ? "Add transactions" : "Add an account"}
        />
      </div>
    );
  }
  const filters = await loadFilterContext(books, await searchParams, "this_month");
  const [columns, board] = await Promise.all([loadHistory(books), getSpendingBreakdown(books, filters.filter, filters.today)]);
  if (!board.ok) throw new Error(board.memberMessage);
  return (
    <div className="space-y-10">
      <div>
        <h1 className="font-serif text-4xl">History</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Where the money went, filtered any way you like, and month over month. Pick a category or account to see its transactions.
        </p>
      </div>
      <section id="spending" className="scroll-mt-20 space-y-4" aria-labelledby="spending-heading">
        <h2 id="spending-heading" className="font-serif text-2xl">
          Spending
        </h2>
        <FilterBar path="/history" anchor="#spending" ctx={filters} />
        {board.value.totals.transactionCount === 0 ? (
          <NextStep
            title="Nothing in this view"
            body="No transactions match this range and these filters. Try all time, or clear the filters."
            href="/history?range=all#spending"
            action="Show all time"
          />
        ) : (
          <SpendingDashboardView board={board.value} />
        )}
      </section>
      <section className="space-y-4" aria-labelledby="months-heading">
        <div>
          <h2 id="months-heading" className="font-serif text-2xl">
            Month over month
          </h2>
          <p className="max-w-2xl text-sm text-muted-foreground">
            All spending, the last 12 months. Green means you spent less. Red means more. This month stays open.
          </p>
        </div>
        <HistoryChart columns={columns} />
      </section>
    </div>
  );
}
