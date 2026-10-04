import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "./schema";

export type AppDatabase = PostgresJsDatabase<typeof schema>;
export type AppTx = Parameters<Parameters<AppDatabase["transaction"]>[0]>[0];

let appDb: AppDatabase | undefined;

export function getDb(): AppDatabase {
  if (!appDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is required");
    appDb = drizzle(postgres(url, { max: process.env.VERCEL ? 1 : 10 }), { schema });
  }
  return appDb;
}
