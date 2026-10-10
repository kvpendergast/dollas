import { HistoryChart } from "@/components/history/history-chart";
import { SpendingDashboardView } from "@/components/spending/dashboard";
import { FilterBar } from "@/components/spending/filter-bar";
import { requireBooks } from "@/slices/access/guard";
import { loadHistory } from "@/slices/books/queries";
import { loadFilterContext } from "@/slices/spending/load";
import { getSpendingBreakdown } from "@/slices/spending/service";

export default async function HistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const books = await requireBooks();
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
      <section className="space-y-4" aria-labelledby="spending-heading">
        <h2 id="spending-heading" className="font-serif text-2xl">
          Spending
        </h2>
        <FilterBar path="/history" ctx={filters} />
        <SpendingDashboardView board={board.value} />
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
