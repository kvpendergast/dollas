import { sql } from "drizzle-orm";
import { getDb, type AppDatabase, type AppTx } from "./client";

/**
 * Sets the RLS session user for this transaction only.
 * The connection assumes dollas_app for the same transaction, so a query with
 * no membership predicate still cannot read another household.
 */
export async function withActor<T>(
  userId: string,
  fn: (tx: AppTx) => Promise<T>,
  database: AppDatabase = getDb(),
): Promise<T> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}
