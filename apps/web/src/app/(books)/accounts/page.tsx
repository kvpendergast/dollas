import { formatCents } from "@dollas/domain";
import { AccountForm } from "@/components/forms/account-form";
import { DisconnectConnectionForm } from "@/components/forms/disconnect-connection";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireBooks } from "@/slices/access/guard";
import { loadAccounts } from "@/slices/books/queries";
import { loadBankConnections } from "@/slices/connections/queries";

export default async function AccountsPage() {
  const books = await requireBooks();
  const [accounts, connections] = await Promise.all([loadAccounts(books), loadBankConnections(books)]);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-4xl">Accounts</h1>
        <p className="text-sm text-muted-foreground">Opening money, plus every transaction since. That&apos;s the balance.</p>
      </div>
      {accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">No dollas in here yet. Add an account.</p>
      ) : null}
      <div className="grid gap-4 md:grid-cols-3">
        {accounts.map((account) => {
          const owed = account.type === "credit" && account.balanceCents < 0;
          return (
            <Card key={account.id}>
              <CardHeader>
                <CardDescription className="capitalize">{account.type}</CardDescription>
                <CardTitle>{account.name}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className={`font-serif text-3xl tabular-nums ${owed ? "text-over" : "text-income"}`}>
                  {formatCents(owed ? -account.balanceCents : account.balanceCents)}
                </p>
                <p className="text-xs text-muted-foreground">{owed ? "Owed" : "Balance"}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>
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
