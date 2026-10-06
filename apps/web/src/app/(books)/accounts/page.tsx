import { accountsForActiveLists, accountsForHistory, formatCents, isAccountType, SIMPLEFIN_PROVIDER_ID } from "@dollas/domain";
import { AccountForm } from "@/components/forms/account-form";
import { AccountControls } from "@/components/forms/account-controls";
import { DisconnectConnectionForm } from "@/components/forms/disconnect-connection";
import { SimpleFinLinkForm } from "@/components/forms/simplefin-link";
import { SyncConnectionForm } from "@/components/forms/sync-connection";
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
            Paste a SimpleFIN setup token from your bank. Dollas claims it once and stores the access URL encrypted.
            Disconnect deletes that token. A bank username or password is not a connection.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {connections.length === 0 ? (
            <p className="text-sm text-muted-foreground">No bank is connected.</p>
          ) : (
            <div className="space-y-4">
              {connections.map((connection) => (
                <div key={connection.id} className="space-y-3 rounded-xl bg-background px-4 py-3 ring-1 ring-foreground/10">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-serif text-2xl">{connection.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {connection.providerId}
                        {connection.transactionsSince ? ` · transactions since ${connection.transactionsSince}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-start gap-2">
                      {connection.providerId === SIMPLEFIN_PROVIDER_ID ? (
                        <SyncConnectionForm connectionId={connection.id} />
                      ) : null}
                      <DisconnectConnectionForm connectionId={connection.id} label={connection.label} />
                    </div>
                  </div>
                  {connection.accounts.length > 0 ? (
                    <ul className="space-y-1 text-sm text-muted-foreground">
                      {connection.accounts.map((account) => (
                        <li key={account.providerAccountId}>
                          {account.name} · bank balance {formatCents(account.balanceCents, account.currency)}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </div>
          )}
          <SimpleFinLinkForm />
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
