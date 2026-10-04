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
          Spending from the books, month over month and year over year. Green means this year spent less. Red means more.
          The current month stays open.
        </p>
      </div>
      <HistoryChart columns={columns} />
    </div>
  );
}
