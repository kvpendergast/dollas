import { eq } from "drizzle-orm";
import { withActor } from "@/db/actor";
import { bankAccount, bankConnection, ledgerAccount } from "@/db/schema";

export type BankConnectionAccount = {
  providerAccountId: string;
  name: string;
  balanceCents: number;
  currency: string;
};

export type BankConnectionListItem = {
  id: string;
  providerId: string;
  label: string;
  transactionsSince: string | null;
  accounts: BankConnectionAccount[];
};

export async function loadBankConnections(books: {
  userId: string;
  householdId: string;
}): Promise<BankConnectionListItem[]> {
  return withActor(books.userId, async (tx) => {
    const connections = await tx
      .select({
        id: bankConnection.id,
        providerId: bankConnection.providerId,
        label: bankConnection.label,
        transactionsSince: bankConnection.transactionsSince,
      })
      .from(bankConnection)
      .where(eq(bankConnection.householdId, books.householdId));
    const accounts = await tx
      .select({
        connectionId: bankAccount.connectionId,
        providerAccountId: bankAccount.providerAccountId,
        name: ledgerAccount.name,
        balanceCents: bankAccount.balanceCents,
        currency: bankAccount.currency,
      })
      .from(bankAccount)
      .innerJoin(ledgerAccount, eq(ledgerAccount.id, bankAccount.ledgerAccountId))
      .where(eq(bankAccount.householdId, books.householdId));
    return connections.map((connection) => ({
      ...connection,
      accounts: accounts
        .flatMap((account) =>
          account.connectionId === connection.id
            ? [
                {
                  providerAccountId: account.providerAccountId,
                  name: account.name,
                  balanceCents: account.balanceCents,
                  currency: account.currency,
                },
              ]
            : [],
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));
  });
}
