import { accountsForActiveLists, toIsoDate } from "@dollas/domain";
import { ActivityLedger } from "@/components/forms/activity-ledger";
import { ImportForm } from "@/components/forms/import-form";
import { PayeeRules } from "@/components/forms/payee-rule-form";
import { TransactionForm } from "@/components/forms/transaction-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireBooks } from "@/slices/access/guard";
import { loadCsvImportPanel } from "@/slices/activity/import-csv";
import { PAYEE_RULES_APPLY_TO } from "@/slices/activity/payee-rule-copy";
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
  const [activity, csvImports] = await Promise.all([loadActivity(books), loadCsvImportPanel()]);
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
          <CardDescription>{PAYEE_RULES_APPLY_TO}</CardDescription>
        </CardHeader>
        <CardContent>
          <PayeeRules rules={activity.payeeRules} categories={activity.categories} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Import a CSV</CardTitle>
          <CardDescription>
            Preview the rows before they are added. Importing the same file again adds nothing. A transaction you
            delete stays deleted, and that line is not added again. Undo removes only the transactions that import
            added, so you can import the file again after that.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ImportForm batches={csvImports.open} undoneNotice={csvImports.undoneNotice} />
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
