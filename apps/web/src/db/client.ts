import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { appPoolConfig } from "./app-pool";
import { asAppRole } from "./app-role";
import { schema } from "./schema";

export type AppDatabase = PostgresJsDatabase<typeof schema>;
export type AppTx = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

let appDb: AppDatabase | undefined;
let closeAppDb: (() => Promise<void>) | undefined;

/**
 * Opens a pool whose statements run as dollas_app. With `bridge` (the default)
 * each transaction assumes dollas_app, for a login that owns the tables. A
 * dollas_app login (DATABASE_URL_APP) needs no bridge.
 */
export function openAppDatabase(
  url: string,
  max = 10,
  options: { bridge?: boolean } = {},
): { db: AppDatabase; close: () => Promise<void> } {
  const sql = postgres(url, { max });
  return {
    db: drizzle(options.bridge === false ? sql : asAppRole(sql), { schema }),
    close: () => sql.end({ timeout: 5 }),
  };
}

/** The shared pool for pages, server actions, Better Auth, and /api/mcp. */
export function getDb(): AppDatabase {
  if (!appDb) {
    const config = appPoolConfig(process.env);
    const opened = openAppDatabase(config.url, process.env.VERCEL ? 1 : 10, { bridge: config.mode === "bridge" });
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
