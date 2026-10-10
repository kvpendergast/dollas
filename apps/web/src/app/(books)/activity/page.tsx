import { accountsForActiveLists, filterHref, filterToSearchParams, toIsoDate } from "@dollas/domain";
import Link from "next/link";
import { ActivityLedger } from "@/components/forms/activity-ledger";
import { ImportForm } from "@/components/forms/import-form";
import { PayeeRules } from "@/components/forms/payee-rule-form";
import { TransactionForm } from "@/components/forms/transaction-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireBooks } from "@/slices/access/guard";
import { loadCsvImportPanel } from "@/slices/activity/import-csv";
import { PAYEE_RULES_APPLY_TO } from "@/slices/activity/payee-rule-copy";
import { ACTIVITY_PAGE_SIZE, loadActivity } from "@/slices/books/queries";
import { FilterBar } from "@/components/spending/filter-bar";
import { NextStep } from "@/components/onboarding/next-step";
import { StarterCategoriesButton } from "@/components/onboarding/onboarding-forms";
import { loadFilterContext } from "@/slices/spending/load";

function editAccounts<T extends { id: string; name: string; archivedAt: string | null }>(
  active: readonly T[],
  all: readonly T[],
  currentId: string,
) {
  const choices = active.some((account) => account.id === currentId)
    ? active
    : [...active, ...all.filter((account) => account.id === currentId)];
  return choices.map((account) => ({
    id: account.id,
    name: account.name,
    archived: account.archivedAt !== null,
  }));
}

function Pager({ page, pageCount, total, hrefFor }: { page: number; pageCount: number; total: number; hrefFor: (page: number) => string }) {
  const first = total === 0 ? 0 : (page - 1) * ACTIVITY_PAGE_SIZE + 1;
  const last = Math.min(total, page * ACTIVITY_PAGE_SIZE);
  return (
    <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-3 text-sm">
      <p className="text-muted-foreground tabular-nums">
        {total === 0 ? "No transactions" : `${first}–${last} of ${total} transaction${total === 1 ? "" : "s"}`}
      </p>
      {pageCount > 1 ? (
        <div className="flex items-center gap-3">
          {page > 1 ? (
            <Link href={hrefFor(page - 1)} className="font-medium text-primary underline-offset-4 hover:underline" rel="prev">
              ← Newer
            </Link>
          ) : null}
          <span className="text-muted-foreground tabular-nums">
            Page {page} of {pageCount}
          </span>
          {page < pageCount ? (
            <Link href={hrefFor(page + 1)} className="font-medium text-primary underline-offset-4 hover:underline" rel="next">
              Older →
            </Link>
          ) : null}
        </div>
      ) : null}
    </nav>
  );
}

export default async function ActivityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const books = await requireBooks();
  const params = await searchParams;
  const filters = await loadFilterContext(books, params, "all");
  const requestedPage = Number(Array.isArray(params.page) ? params.page[0] : params.page);
  const [activity, csvImports] = await Promise.all([
    loadActivity(books, { filter: filters.filter, page: Number.isFinite(requestedPage) ? requestedPage : 1 }),
    loadCsvImportPanel(),
  ]);
  const filtered = filterToSearchParams(filters.filter, "all").toString() !== "";
  const hrefFor = (page: number) => `${filterHref("/activity", filters.filter, "all", page > 1 ? { page: String(page) } : {})}#transactions`;
  const newEntryAccounts = accountsForActiveLists(activity.accounts, books.householdId);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-4xl">Activity</h1>
        <p className="text-sm text-muted-foreground">
          What came in, what went out, splits included.{" "}
          <a href="#transactions" className="font-medium text-primary underline-offset-4 hover:underline">
            Find a transaction
          </a>{" "}
          ·{" "}
          <a href="#import" className="font-medium text-primary underline-offset-4 hover:underline">
            Import a CSV
          </a>{" "}
          ·{" "}
          <a href="#payee-rules" className="font-medium text-primary underline-offset-4 hover:underline">
            Payee rules
          </a>
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Add one</CardTitle>
          <CardDescription>One stop, two categories? Split it.</CardDescription>
        </CardHeader>
        <CardContent>
          {newEntryAccounts.length === 0 ? (
            <NextStep
              title="Add an account first"
              body="Every transaction belongs to an account: checking, a card, or cash. Add one by hand, or link a bank and transactions arrive on their own."
              href="/accounts"
              action="Add an account"
            />
          ) : activity.categories.length === 0 ? (
            <NextStep
              title="Set up categories next"
              body="Each transaction gets a category, and there are none yet. Add a starter set in one click, or make your own."
              extra={
                <>
                  <StarterCategoriesButton />
                  <Link href="/categories" className="inline-flex h-8 items-center px-2 text-sm font-medium text-primary underline-offset-4 hover:underline">
                    Make my own
                  </Link>
                </>
              }
            />
          ) : (
            <TransactionForm
              accounts={newEntryAccounts}
              categories={activity.categories}
              today={toIsoDate(books.asOf)}
            />
          )}
          {activity.accounts.some((account) => account.archivedAt !== null) ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Archived accounts are not listed for new entries. Their past transactions stay below.
            </p>
          ) : null}
        </CardContent>
      </Card>
      <section id="transactions" className="scroll-mt-20 space-y-4" aria-labelledby="ledger-heading">
        <h2 id="ledger-heading" className="font-serif text-2xl">
          Transactions
        </h2>
        <FilterBar path="/activity" anchor="#transactions" ctx={filters} />
        {activity.total > 0 ? <Pager page={activity.page} pageCount={activity.pageCount} total={activity.total} hrefFor={hrefFor} /> : null}
        {activity.transactions.length === 0 ? (
          filtered ? (
            <NextStep title="Nothing matches these filters" body="Try a wider date range, or clear the filters." href="/activity#transactions" action="Clear filters" />
          ) : newEntryAccounts.length === 0 ? (
            <NextStep title="No transactions yet" body="Add an account, then add transactions here, import a CSV, or link a bank." href="/accounts" action="Add an account" />
          ) : (
            <NextStep
              title="No transactions yet"
              body="Add one above, import a CSV from your bank, or link a bank on Accounts."
              href="#import"
              action="Import a CSV"
            />
          )
        ) : null}
      <ActivityLedger
        categories={activity.categories}
        recurringChoices={activity.recurringChoices}
        transactions={activity.transactions.map((item) => ({
          ...item,
          accounts: editAccounts(newEntryAccounts, activity.accounts, item.accountId),
        }))}
        />
        {activity.pageCount > 1 ? <Pager page={activity.page} pageCount={activity.pageCount} total={activity.total} hrefFor={hrefFor} /> : null}
      </section>
      <Card id="payee-rules" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Payee rules</CardTitle>
          <CardDescription>{PAYEE_RULES_APPLY_TO}</CardDescription>
        </CardHeader>
        <CardContent>
          <PayeeRules rules={activity.payeeRules} categories={activity.categories} />
        </CardContent>
      </Card>
      <Card id="import" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Import a CSV</CardTitle>
          <CardDescription>
            Preview the rows before they are added. Importing the same file again adds nothing. A transaction you
            delete stays deleted, and that line is not added again. Undo removes only the transactions that import
            added, so you can import the file again after that.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {newEntryAccounts.length === 0 && csvImports.open.length === 0 ? (
            <NextStep title="Add an account to import into" body="A CSV lands in one account. Add it first." href="/accounts" action="Add an account" />
          ) : (
            <ImportForm
              accounts={newEntryAccounts.map((account) => ({ id: account.id, name: account.name }))}
              batches={csvImports.open}
              undoneNotice={csvImports.undoneNotice}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
