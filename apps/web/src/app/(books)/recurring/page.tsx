import { StatCard } from "@/components/app/stat-card";
import { PageHeader } from "@/components/app/page-header";
import { CADENCE_LABELS, formatCents } from "@dollas/domain";
import Link from "next/link";
import { EmptyState } from "@/components/app/empty-state";
import { MakeRecurringButton, RecurringItemForm } from "@/components/recurring/recurring-forms";
import { StatusPill } from "@/components/app/status-pill";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireBooks } from "@/slices/access/guard";
import { loadRecurringPage } from "@/slices/recurring/load";

function shortDate(iso: string | null): string {
  if (!iso) return "No date ahead";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
}

export default async function RecurringPage() {
  const books = await requireBooks();
  const page = await loadRecurringPage(books);
  const { month } = page;
  const money = (cents: number) => formatCents(cents, books.currency);

  return (
    <div className="space-y-6">
      <PageHeader title="Recurring" description={<>Known bills and paychecks. A matching transaction links to its item instead of standing alone.</>} />

      <div className="grid gap-3 sm:grid-cols-2">
        <StatCard
          size="lg"
          label="Bills this month"
          value={`${money(month.paid.expenseCents)} paid`}
          note={
            <span className="text-sm tabular-nums">
              {money(month.expected.expenseCents)} still expected
              {month.missed.expenseCents > 0 ? ` · ${money(month.missed.expenseCents)} missed` : ""}
            </span>
          }
        />
        <StatCard
          size="lg"
          tone="income"
          label="Income this month"
          value={`${money(month.paid.incomeCents)} received`}
          note={
            <span className="text-sm tabular-nums">
              {money(month.expected.incomeCents)} still expected
              {month.missed.incomeCents > 0 ? ` · ${money(month.missed.incomeCents)} missed` : ""}
            </span>
          }
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Your recurring items</CardTitle>
          <CardDescription>Next date, amount, and where each stands this month.</CardDescription>
        </CardHeader>
        <CardContent>
          {page.items.length === 0 ? (
            <EmptyState
              title="Nothing recurring yet"
              body="Add rent, a paycheck, or a subscription. Matching transactions link to it, and the Spend estimate counts what is still due."
              href="#add-recurring"
              action="Add a recurring item"
            />
          ) : (
            <ul className="divide-y-2 divide-dashed divide-border-soft">
              {page.items.map((item) => (
                <li key={item.id}>
                  <Link
                    href={`/recurring/${item.id}`}
                    className="-mx-2 flex items-center justify-between gap-3 rounded-full px-2 py-3 hover:bg-muted"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{item.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {CADENCE_LABELS[item.cadence]} · {item.paused ? "Paused" : `Next ${shortDate(item.nextDate)}`}
                        {item.categoryName ? ` · ${item.categoryName}` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span className={`font-heading text-lg tabular-nums ${item.amountCents > 0 ? "text-income" : ""}`}>
                        {money(item.amountCents)}
                      </span>
                      <StatusPill status={item.monthStatus} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {page.suggestions.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Looks recurring</CardTitle>
            <CardDescription>Payees that show up on a steady schedule. Make one recurring to track it.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y-2 divide-dashed divide-border-soft">
              {page.suggestions.map((suggestion) => (
                <li key={`${suggestion.payeeMatch}:${suggestion.amountCents}`} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{suggestion.name}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {CADENCE_LABELS[suggestion.cadence]} · about {money(suggestion.amountCents)} · seen {suggestion.count} times
                    </p>
                  </div>
                  <MakeRecurringButton
                    suggestion={{
                      ...suggestion,
                      dayOfMonth: null,
                      toleranceCents: 0,
                      windowDays: 3,
                      startDate: null,
                      endDate: null,
                    }}
                  />
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card id="add-recurring" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Add a recurring item</CardTitle>
          <CardDescription>Matching transactions from the last six months link right away.</CardDescription>
        </CardHeader>
        <CardContent>
          <RecurringItemForm
            submitLabel="Add recurring item"
            categories={page.categories}
            accounts={page.accounts}
            values={{
              name: "",
              payeeMatch: "",
              amountCents: 0,
              cadence: "monthly",
              anchorDate: page.today,
              dayOfMonth: null,
              secondDayOfMonth: null,
              categoryId: null,
              accountId: null,
              tolerancePercent: 5,
              toleranceCents: 0,
              windowDays: 3,
              startDate: null,
              endDate: null,
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
