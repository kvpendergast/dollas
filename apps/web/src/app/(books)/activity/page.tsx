import { accountsForActiveLists, toIsoDate } from "@dollas/domain";
import { ActivityLedger } from "@/components/forms/activity-ledger";
import { ImportForm } from "@/components/forms/import-form";
import { PayeeRules } from "@/components/forms/payee-rule-form";
import { TransactionForm } from "@/components/forms/transaction-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireBooks } from "@/slices/access/guard";
import { loadActivity } from "@/slices/books/queries";

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

export default async function ActivityPage() {
  const books = await requireBooks();
  const activity = await loadActivity(books);
  const newEntryAccounts = accountsForActiveLists(activity.accounts, books.householdId);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-4xl">Activity</h1>
        <p className="text-sm text-muted-foreground">What came in, what went out, splits included.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Add one</CardTitle>
          <CardDescription>One stop, two categories? Split it.</CardDescription>
        </CardHeader>
        <CardContent>
          <TransactionForm
            accounts={newEntryAccounts}
            categories={activity.categories}
            today={toIsoDate(books.asOf)}
          />
          {activity.accounts.some((account) => account.archivedAt !== null) ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Archived accounts are not listed for new entries. Their past transactions stay below.
            </p>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Payee rules</CardTitle>
          <CardDescription>
            When a payee on a new import contains this text, that transaction uses this category. A longer match wins.
            Editing or deleting one transaction does not change the rule.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PayeeRules rules={activity.payeeRules} categories={activity.categories} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Import a CSV</CardTitle>
          <CardDescription>
            Bring transactions in from a file on this computer. A CSV import does not use a bank connection.
            Importing the same file again does not add duplicates. A deleted row stays deleted: its import fingerprint
            is kept, so that same CSV line does not come back.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ImportForm />
        </CardContent>
      </Card>
      {activity.transactions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {newEntryAccounts.length === 0 ? "No dollas in here yet. Add an account." : "No dollas in here yet."}
        </p>
      ) : null}
      <ActivityLedger
        categories={activity.categories}
        transactions={activity.transactions.map((item) => ({
          ...item,
          accounts: editAccounts(newEntryAccounts, activity.accounts, item.accountId),
        }))}
      />
    </div>
  );
}
