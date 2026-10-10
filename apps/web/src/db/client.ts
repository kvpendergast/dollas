import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { asAppRole } from "./app-role";
import { schema } from "./schema";

export type AppDatabase = PostgresJsDatabase<typeof schema>;
export type AppTx = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

let appDb: AppDatabase | undefined;
let closeAppDb: (() => Promise<void>) | undefined;

/** Opens a pool whose statements run as dollas_app, including when the login owns the tables. */
export function openAppDatabase(url: string, max = 10): { db: AppDatabase; close: () => Promise<void> } {
  const sql = postgres(url, { max });
  return {
    db: drizzle(asAppRole(sql), { schema }),
    close: () => sql.end({ timeout: 5 }),
  };
}

export function getDb(): AppDatabase {
  if (!appDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required");
    const opened = openAppDatabase(url, process.env.VERCEL ? 1 : 10);
    appDb = opened.db;
    closeAppDb = opened.close;
  }
  return appDb;
}

/** Closes the shared pool. Scripts and tests call this so the process can exit. */
export async function closeDb(): Promise<void> {
  const close = closeAppDb;
  appDb = undefined;
  closeAppDb = undefined;
  if (close) await close();
}
