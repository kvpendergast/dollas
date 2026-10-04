import { sql } from "drizzle-orm";
import { getDb, type AppTx } from "./client";

/** Sets the RLS session user for this transaction only. */
export async function withActor<T>(userId: string, fn: (tx: AppTx) => Promise<T>): Promise<T> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}
