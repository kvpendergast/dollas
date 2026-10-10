import Link from "next/link";
import { accountsForActiveLists, accountsForHistory, formatCents, isAccountType, PLAID_PROVIDER_ID, SIMPLEFIN_PROVIDER_ID } from "@dollas/domain";
import { AccountForm } from "@/components/forms/account-form";
import { AccountControls } from "@/components/forms/account-controls";
import { DisconnectConnectionForm } from "@/components/forms/disconnect-connection";
import { PlaidLinkForm } from "@/components/forms/plaid-link";
import { SimpleFinLinkForm } from "@/components/forms/simplefin-link";
import { SyncConnectionForm } from "@/components/forms/sync-connection";
import { Badge } from "@/components/ui/badge";
import { NextStep } from "@/components/onboarding/next-step";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireBooks } from "@/slices/access/guard";
import { loadAccounts, type AccountListItem } from "@/slices/books/queries";
import { plaidLinkEnabled } from "@/slices/connections/plaid-config";
import { listBankConnections } from "@/slices/connections/service";

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
  const plaidEnabled = plaidLinkEnabled();
  const [accounts, connections] = await Promise.all([loadAccounts(books), listBankConnections(books)]);
  const listed = accounts.filter((account) => isAccountType(account.type));
  const active = accountsForActiveLists(listed, books.householdId);
  const archived = accountsForHistory(listed, books.householdId).filter((account) => account.archivedAt !== null);
  // With no accounts yet, the add form comes first; it is the next step.
  const addCard = (
    <Card id="add-account" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>Add an account</CardTitle>
        <CardDescription>Checking, savings, a credit card, or cash. You can link a bank for it later.</CardDescription>
      </CardHeader>
      <CardContent>
        <AccountForm />
      </CardContent>
    </Card>
  );
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-4xl">Accounts</h1>
        <p className="text-sm text-muted-foreground">Opening money, plus every transaction since. That&apos;s the balance.</p>
      </div>
      {active.length === 0 ? (
        <>
          <NextStep
            title="No accounts yet"
            body="Start with the account most spending comes out of. Enter it by hand here, or link a bank below and its accounts come with it."
            extra={
              <Link href="#bank" className="inline-flex h-8 items-center text-sm font-medium text-primary underline-offset-4 hover:underline">
                Link a bank instead
              </Link>
            }
          />
          {addCard}
        </>
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
      <Card id="bank" className="scroll-mt-20">
        <CardHeader>
          <CardTitle>Bank connections</CardTitle>
          <CardDescription>
            {plaidEnabled
              ? "Connect SimpleFIN, Plaid, or both. Each connection stores a provider token encrypted. A bank username or password is not a connection."
              : "Paste a SimpleFIN setup token from your bank. Dollas claims it once and stores the access URL encrypted. Disconnect deletes that token. A bank username or password is not a connection."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {connections.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No bank is connected. Linking is optional: you can add accounts by hand and import CSVs on Activity.
            </p>
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
                      {connection.providerId === SIMPLEFIN_PROVIDER_ID || connection.providerId === PLAID_PROVIDER_ID ? (
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
          <div className="space-y-3">
            <h3 className="font-serif text-xl">SimpleFIN</h3>
            <SimpleFinLinkForm />
          </div>
          {plaidEnabled ? (
            <div className="space-y-3 border-t border-foreground/10 pt-6">
              <h3 className="font-serif text-xl">Plaid</h3>
              <p className="text-sm text-muted-foreground">
                Link a bank through Plaid. It can sit beside a SimpleFIN connection, on a different account.
              </p>
              <PlaidLinkForm enabled />
            </div>
          ) : null}
        </CardContent>
      </Card>
      {active.length > 0 ? addCard : null}
    </div>
  );
}
