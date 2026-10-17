import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb, type AppDatabase } from "@/db/client";

/**
 * Database-backed fixed-window rate limits. Serverless instances do not share
 * memory, so an in-memory counter lets an attacker spread attempts across
 * instances. One atomic upsert per attempt keeps the count exact.
 *
 * Keys are hashed: the table never holds a raw address or email.
 */
export type RateRule = { max: number; windowSeconds: number };
export type RateDecision = { allowed: boolean; retryAfterSeconds: number };

export function rateKey(scope: string, identity: string): string {
  return createHash("sha256").update(`${scope}\n${identity.trim().toLowerCase()}`).digest("hex");
}

/** Counts one attempt. Blocked attempts count too but never extend the window. */
export async function consumeRate(key: string, rule: RateRule, database: AppDatabase = getDb()): Promise<RateDecision> {
  const window = Math.max(1, Math.floor(rule.windowSeconds));
  const rows = (await database.execute(sql`
    insert into rate_limit as r (key, count, window_start)
    values (${key}, 1, now())
    on conflict (key) do update set
      count = case when r.window_start <= now() - make_interval(secs => ${window}) then 1 else r.count + 1 end,
      window_start = case when r.window_start <= now() - make_interval(secs => ${window}) then now() else r.window_start end
    returning
      count,
      ceil(extract(epoch from (window_start + make_interval(secs => ${window}) - now())))::int as retry_after
  `)) as unknown as Array<{ count: number; retry_after: number }>;
  const row = rows[0];
  if (!row) throw new Error("rate limit write returned no row");
  if (Math.random() < 0.01) {
    await database.execute(sql`delete from rate_limit where window_start < now() - interval '1 day'`);
  }
  return { allowed: row.count <= rule.max, retryAfterSeconds: Math.max(1, row.retry_after) };
}

/** The first rule that blocks, or null. Every rule is counted so a blocked attacker keeps their window. */
export async function consumeAll(
  checks: Array<{ key: string; rule: RateRule }>,
  database?: AppDatabase,
): Promise<{ retryAfterSeconds: number } | null> {
  let blocked: { retryAfterSeconds: number } | null = null;
  for (const check of checks) {
    const decision = await consumeRate(check.key, check.rule, database);
    if (!decision.allowed && (!blocked || decision.retryAfterSeconds > blocked.retryAfterSeconds)) {
      blocked = { retryAfterSeconds: decision.retryAfterSeconds };
    }
  }
  return blocked;
}

export function tooManyAttempts(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Too many attempts. Wait about ${minutes} ${minutes === 1 ? "minute" : "minutes"} and try again.`;
}

/** Limits for the password and account server actions. Better Auth's HTTP routes use the same table. */
export const AUTH_LIMITS = {
  signInIp: { max: 20, windowSeconds: 15 * 60 },
  signInEmail: { max: 10, windowSeconds: 15 * 60 },
  signUpIp: { max: 10, windowSeconds: 60 * 60 },
  resetPasswordIp: { max: 10, windowSeconds: 60 * 60 },
} as const satisfies Record<string, RateRule>;
