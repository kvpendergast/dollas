import { accountsForActiveLists, accountsForHistory, formatCents, isAccountType } from "@dollas/domain";
import { AccountForm } from "@/components/forms/account-form";
import { AccountControls } from "@/components/forms/account-controls";
import { DisconnectConnectionForm } from "@/components/forms/disconnect-connection";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireBooks } from "@/slices/access/guard";
import { loadAccounts, type AccountListItem } from "@/slices/books/queries";
import { loadBankConnections } from "@/slices/connections/queries";

function AccountCard({ account }: { account: AccountListItem }) {
  const owed = account.type === "credit" && account.balanceCents < 0;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardDescription className="capitalize">{account.type}</CardDescription>
          {account.archivedAt ? <Badge variant="secondary">Archived</Badge> : null}
        </div>
        <CardTitle>{account.name}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className={`font-serif text-3xl tabular-nums ${owed ? "text-over" : "text-income"}`}>
            {formatCents(owed ? -account.balanceCents : account.balanceCents)}
          </p>
          <p className="text-xs text-muted-foreground">{owed ? "Owed" : "Balance"}</p>
        </div>
        <AccountControls
          key={`${account.id}:${account.name}:${account.openingBalanceCents}:${account.archivedAt ?? ""}`}
          account={{
            id: account.id,
            name: account.name,
            type: account.type,
            openingBalanceCents: account.openingBalanceCents,
            transactionCount: account.transactionCount,
            archived: account.archivedAt !== null,
          }}
        />
      </CardContent>
    </Card>
  );
}

export default async function AccountsPage() {
  const books = await requireBooks();
  const [accounts, connections] = await Promise.all([loadAccounts(books), loadBankConnections(books)]);
  const listed = accounts.filter((account) => isAccountType(account.type));
  const active = accountsForActiveLists(listed, books.householdId);
  const archived = accountsForHistory(listed, books.householdId).filter((account) => account.archivedAt !== null);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-4xl">Accounts</h1>
        <p className="text-sm text-muted-foreground">Opening money, plus every transaction since. That&apos;s the balance.</p>
      </div>
      {active.length === 0 ? (
        <p className="text-sm text-muted-foreground">No dollas in here yet. Add an account.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {active.map((account) => (
            <AccountCard key={account.id} account={account} />
          ))}
        </div>
      )}
      {archived.length > 0 ? (
        <section className="space-y-3">
          <div>
            <h2 className="font-serif text-2xl">Archived</h2>
            <p className="text-sm text-muted-foreground">
              Archived accounts leave the home total, account pickers, and new activity. Their transactions stay on
              Activity and History.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {archived.map((account) => (
              <AccountCard key={account.id} account={account} />
            ))}
          </div>
        </section>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Bank connections</CardTitle>
          <CardDescription>
            Disconnect deletes the stored token. Dollas never asks for a bank username or password.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {connections.length === 0 ? (
            <p className="text-sm text-muted-foreground">No bank is connected.</p>
          ) : (
            connections.map((connection) => (
              <div key={connection.id} className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-serif text-2xl">{connection.label}</p>
                  <p className="text-xs text-muted-foreground">{connection.providerId}</p>
                </div>
                <DisconnectConnectionForm connectionId={connection.id} label={connection.label} />
              </div>
            ))
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Add an account</CardTitle>
        </CardHeader>
        <CardContent>
          <AccountForm />
        </CardContent>
      </Card>
    </div>
  );
}
