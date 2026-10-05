import { HistoryChart } from "@/components/history/history-chart";
import { requireBooks } from "@/slices/access/guard";
import { loadHistory } from "@/slices/books/queries";

export default async function HistoryPage() {
  const books = await requireBooks();
  const columns = await loadHistory(books);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-4xl">History</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Month over month, year over year. Green means you spent less. Red means more. This month stays open.
        </p>
      </div>
      <HistoryChart columns={columns} />
    </div>
  );
}
