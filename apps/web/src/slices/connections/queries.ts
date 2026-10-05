import { eq } from "drizzle-orm";
import { withActor } from "@/db/actor";
import { bankConnection } from "@/db/schema";
import type { BooksContext } from "@/slices/access/guard";

export async function loadBankConnections(books: BooksContext) {
  return withActor(books.userId, (tx) =>
    tx
      .select({
        id: bankConnection.id,
        providerId: bankConnection.providerId,
        label: bankConnection.label,
      })
      .from(bankConnection)
      .where(eq(bankConnection.householdId, books.householdId)),
  );
}
