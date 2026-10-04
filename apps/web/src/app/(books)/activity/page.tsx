import { formatCents, toIsoDate } from "@dollas/domain";
import { TransactionForm } from "@/components/forms/transaction-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireBooks } from "@/slices/access/guard";
import { loadActivity } from "@/slices/books/queries";

export default async function ActivityPage() {
  const books = await requireBooks();
  const activity = await loadActivity(books);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-4xl">Activity</h1>
        <p className="text-sm text-muted-foreground">Transactions from the household books, including category splits.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Add a transaction</CardTitle>
          <CardDescription>Split the amount when one purchase covers more than one category.</CardDescription>
        </CardHeader>
        <CardContent>
          <TransactionForm
            accounts={activity.accounts}
            categories={activity.categories}
            today={toIsoDate(books.asOf)}
          />
        </CardContent>
      </Card>
      <div className="space-y-3">
        {activity.transactions.map((item) => {
          const split = item.splits.length > 1;
          return (
            <article key={item.id} className="rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{item.payee}</p>
                  <p className="text-xs text-muted-foreground">
                    {item.occurredOn} · {item.accountName}
                    {split ? "" : ` · ${item.splits[0]?.categoryName ?? "Uncategorized"}`}
                  </p>
                </div>
                <div className="text-right">
                  <p className={`font-serif text-lg tabular-nums ${item.amountCents > 0 ? "text-income" : ""}`}>
                    {formatCents(item.amountCents)}
                  </p>
                  {split ? <Badge variant="secondary">Split</Badge> : null}
                </div>
              </div>
              {split ? (
                <ul className="mt-3 space-y-1 border-t border-border pt-2 text-sm">
                  {item.splits.map((part) => (
                    <li key={part.categoryName} className="flex justify-between gap-3">
                      <span>{part.categoryName}</span>
                      <span className="tabular-nums">{formatCents(part.amountCents)}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}
