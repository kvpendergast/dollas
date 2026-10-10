import { ConfigError } from "@dollas/domain";

type Env = Record<string, string | undefined>;

/** Local development only. Hosted deploys must set BETTER_AUTH_SECRET. */
const LOCAL_DEV_SECRET = "dollas-local-dev-secret";

/**
 * Signs sessions and invite link tokens. Rotating it signs everyone out and
 * turns open invite links off; owners can send those invites again.
 */
export function serverSecret(env: Env = process.env): string {
  const value = env.BETTER_AUTH_SECRET?.trim();
  if (value) return value;
  if (env.VERCEL_ENV) throw new ConfigError("BETTER_AUTH_SECRET is required");
  return LOCAL_DEV_SECRET;
}

/** Public site origin, including the scheme. Used for auth callbacks and invite links. */
export function siteOrigin(env: Env = process.env): string {
  if (env.BETTER_AUTH_URL) return env.BETTER_AUTH_URL.replace(/\/+$/, "");
  if (env.VERCEL_ENV === "production" && env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
  return "http://localhost:3000";
}
