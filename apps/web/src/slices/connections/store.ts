import { type BankConnectionQueries } from "@dollas/domain";
import { and, eq } from "drizzle-orm";
import type { AppDatabase, AppTx } from "@/db/client";
import { bankConnection } from "@/db/schema";
import { logError } from "@/lib/telemetry";

type ConnectionDb = Pick<AppDatabase, "insert" | "select" | "delete">;

/** Household-scoped queries. The public list never selects the sealed token. */
export function drizzleBankConnectionQueries(db: ConnectionDb | AppTx): BankConnectionQueries {
  return {
    async insert(connection) {
      try {
        await db.insert(bankConnection).values({
          id: connection.id,
          householdId: connection.householdId,
          providerId: connection.providerId,
          label: connection.label,
          encryptedAccessToken: connection.encryptedAccessToken,
          keyVersion: connection.keyVersion,
        });
      } catch (error) {
        logError(error, { action: "save-bank-connection", householdId: connection.householdId });
        throw error;
      }
    },
    async selectOne(householdId, connectionId) {
      const [row] = await db
        .select({
          id: bankConnection.id,
          householdId: bankConnection.householdId,
          providerId: bankConnection.providerId,
          label: bankConnection.label,
          encryptedAccessToken: bankConnection.encryptedAccessToken,
          keyVersion: bankConnection.keyVersion,
        })
        .from(bankConnection)
        .where(and(eq(bankConnection.householdId, householdId), eq(bankConnection.id, connectionId)));
      return row ?? null;
    },
    async selectPublic(householdId) {
      return db
        .select({
          id: bankConnection.id,
          householdId: bankConnection.householdId,
          providerId: bankConnection.providerId,
          label: bankConnection.label,
        })
        .from(bankConnection)
        .where(eq(bankConnection.householdId, householdId));
    },
    async remove(householdId, connectionId) {
      const deleted = await db
        .delete(bankConnection)
        .where(and(eq(bankConnection.householdId, householdId), eq(bankConnection.id, connectionId)))
        .returning({ id: bankConnection.id });
      return deleted.length > 0;
    },
  };
}
