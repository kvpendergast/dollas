import { formatCents } from "@dollas/domain";
import Link from "next/link";
import { RecurringItemControls, RecurringItemForm, UnlinkRecurringButton } from "@/components/recurring/recurring-forms";
import { RecurringStatusBadge } from "@/components/recurring/status-badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireBooks } from "@/slices/access/guard";
import { loadRecurringDetail } from "@/slices/recurring/load";

function longDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );
}

export default async function RecurringItemPage({ params }: { params: Promise<{ id: string }> }) {
  const books = await requireBooks();
  const { id } = await params;
  const page = await loadRecurringDetail(books, id);
  const money = (cents: number) => formatCents(cents, books.currency);
  const back = (
    <Link href="/recurring" className="text-sm text-primary">
      ← Recurring
    </Link>
  );
  if (!page.item) {
    return (
      <div className="space-y-4">
        {back}
        <p role="alert" className="text-sm text-over">
          {page.error}
        </p>
      </div>
    );
  }
  const item = page.item;
  const upcoming = item.occurrences.filter((row) => row.date >= page.today || row.status === "expected");
  const past = item.occurrences.filter((row) => !upcoming.includes(row)).reverse();

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        {back}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-serif text-4xl">{item.name}</h1>
            <p className="text-sm text-muted-foreground">
              <span className={`tabular-nums ${item.amountCents > 0 ? "text-income" : ""}`}>{money(item.amountCents)}</span> ·{" "}
              {item.cadenceLabel}
              {item.paused ? " · Paused" : item.nextDate ? ` · Next ${longDate(item.nextDate)}` : ""}
            </p>
          </div>
          <RecurringItemControls itemId={item.id} name={item.name} paused={item.paused} />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Occurrences</CardTitle>
            <CardDescription>
              Matches a payee containing “{item.payeeMatch}”, within {item.tolerancePercent}%
              {item.toleranceCents > 0 ? ` or ${money(item.toleranceCents)}` : ""} and {item.windowDays} days.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {[...upcoming, ...past].map((row) => (
                <li key={row.date} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm">{longDate(row.date)}</p>
                    {row.transaction ? (
                      <p className="truncate text-xs text-muted-foreground">
                        {row.transaction.payee} · {row.transaction.occurredOn} ·{" "}
                        <span className="tabular-nums">{money(row.transaction.amountCents)}</span>
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {row.transaction ? <UnlinkRecurringButton transactionId={row.transaction.id} payee={row.transaction.payee} /> : null}
                    <RecurringStatusBadge status={row.status} />
                  </div>
                </li>
              ))}
              {item.occurrences.length === 0 ? <li className="py-2 text-sm text-muted-foreground">No occurrences in this range.</li> : null}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
            <CardDescription>Every transaction linked to {item.name}, newest first.</CardDescription>
          </CardHeader>
          <CardContent>
            {item.history.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing linked yet. Link a transaction from Activity.</p>
            ) : (
              <ul className="divide-y divide-border">
                {item.history.map((row) => (
                  <li key={row.transactionId} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <div className="min-w-0">
                      <p className="truncate">{row.payee}</p>
                      <p className="text-xs text-muted-foreground">
                        {row.occurredOn} · for {row.occurrenceDate}
                        {row.source === "manual" ? " · linked by hand" : ""}
                      </p>
                    </div>
                    <span className="tabular-nums">{money(row.amountCents)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Edit</CardTitle>
        </CardHeader>
        <CardContent>
          <RecurringItemForm
            submitLabel="Save"
            categories={page.categories}
            accounts={page.accounts}
            values={{
              id: item.id,
              name: item.name,
              payeeMatch: item.payeeMatch,
              amountCents: item.amountCents,
              cadence: item.cadence,
              anchorDate: item.anchorDate,
              dayOfMonth: item.dayOfMonth,
              secondDayOfMonth: item.secondDayOfMonth,
              categoryId: item.categoryId,
              accountId: item.accountId,
              tolerancePercent: item.tolerancePercent,
              toleranceCents: item.toleranceCents,
              windowDays: item.windowDays,
              startDate: item.startDate,
              endDate: item.endDate,
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
