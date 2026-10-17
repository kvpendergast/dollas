import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import postgres from "postgres";
import { migrateWithUrl } from "../db/apply-migrations";

const OWNER_URL = "postgresql://dollas:dollas@127.0.0.1:5432/dollas";
const APP_URL = "postgresql://dollas_app:dollas@127.0.0.1:5432/dollas";
const ORIGIN = "http://localhost:3000";

describe("database rate limits", () => {
  it("counts across calls exactly, resets after the window, and limits password sign-in over HTTP", async (t) => {
    const owner = postgres(OWNER_URL, { max: 1, prepare: false, connect_timeout: 5, onnotice() {} });
    try {
      await owner`select 1`;
    } catch (error) {
      await owner.end({ timeout: 1 }).catch(() => undefined);
      if (process.env.CI) throw error;
      t.skip("Postgres is not running on 127.0.0.1:5432");
      return;
    }
    await migrateWithUrl(OWNER_URL, { env: { DATABASE_URL: APP_URL } });
    process.env.DATABASE_URL = APP_URL;
    process.env.BETTER_AUTH_URL = ORIGIN;
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM;
    const { consumeAll, consumeRate, rateKey, AUTH_LIMITS } = await import("./rate-limit");
    const { getAuth } = await import("./auth");
    const { closeDb } = await import("../db/client");
    const stamp = randomBytes(6).toString("hex");
    const keys: string[] = [];
    try {
      // Exact counting, no matter which instance asks.
      const key = rateKey("test", `exact-${stamp}`);
      keys.push(key);
      const rule = { max: 3, windowSeconds: 60 };
      const results = [];
      for (let i = 0; i < 5; i += 1) results.push((await consumeRate(key, rule)).allowed);
      assert.deepEqual(results, [true, true, true, false, false]);
      const blocked = await consumeRate(key, rule);
      assert.ok(blocked.retryAfterSeconds >= 1 && blocked.retryAfterSeconds <= 60);

      // Parallel attempts cannot slip past the cap.
      const parallelKey = rateKey("test", `parallel-${stamp}`);
      keys.push(parallelKey);
      const parallel = await Promise.all(Array.from({ length: 12 }, () => consumeRate(parallelKey, { max: 5, windowSeconds: 60 })));
      assert.equal(parallel.filter((item) => item.allowed).length, 5);

      // A new window starts after the old one ends.
      const shortKey = rateKey("test", `short-${stamp}`);
      keys.push(shortKey);
      assert.equal((await consumeRate(shortKey, { max: 1, windowSeconds: 1 })).allowed, true);
      assert.equal((await consumeRate(shortKey, { max: 1, windowSeconds: 1 })).allowed, false);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.equal((await consumeRate(shortKey, { max: 1, windowSeconds: 1 })).allowed, true);

      // Keys are hashed: no raw email or address is stored.
      const raw = await owner`select count(*)::int as n from rate_limit where key like ${`%${stamp}%`}`;
      assert.equal(raw[0]?.n, 0);

      // consumeAll reports the longest wait among blocking rules.
      const all = await consumeAll([
        { key: rateKey("test", `all-a-${stamp}`), rule: { max: 0, windowSeconds: 30 } },
        { key: rateKey("test", `all-b-${stamp}`), rule: { max: 0, windowSeconds: 120 } },
      ]);
      keys.push(rateKey("test", `all-a-${stamp}`), rateKey("test", `all-b-${stamp}`));
      assert.ok(all && all.retryAfterSeconds > 30);

      // Brute force over HTTP: Better Auth's own route is now limited from the shared table.
      const ip = `203.0.113.${(Number.parseInt(stamp.slice(0, 2), 16) % 250) + 1}`;
      const auth = getAuth();
      const attempt = () =>
        auth.handler(
          new Request(`${ORIGIN}/api/auth/sign-in/email`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": ip },
            body: JSON.stringify({ email: `nobody-${stamp}@limits.test`, password: "wrong-password-1" }),
          }),
        );
      const statuses: number[] = [];
      for (let i = 0; i < AUTH_LIMITS.signInIp.max + 3; i += 1) statuses.push((await attempt()).status);
      assert.equal(statuses.slice(0, AUTH_LIMITS.signInIp.max).includes(429), false, "attempts inside the budget are answered normally");
      assert.deepEqual(statuses.slice(AUTH_LIMITS.signInIp.max), [429, 429, 429], "attempts over the budget are refused");
      const stored = await owner`select count(*)::int as n from rate_limit`;
      assert.ok((stored[0]?.n ?? 0) >= 1, "the counters are in Postgres, not instance memory");
    } finally {
      for (const key of keys) await owner`delete from rate_limit where key = ${key}`;
      await owner.end({ timeout: 5 });
      await closeDb();
    }
  });
});
