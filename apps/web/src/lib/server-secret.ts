import { ConfigError } from "@dollas/domain";

type Env = Record<string, string | undefined>;

/** Local development only. Hosted deploys must set BETTER_AUTH_SECRET. */
const LOCAL_DEV_SECRET = "dollas-local-dev-secret";

/** True when the process serves real traffic: Vercel, or any `next start` (NODE_ENV=production). */
function isHosted(env: Env): boolean {
  return Boolean(env.VERCEL_ENV) || env.NODE_ENV === "production";
}

/**
 * Signs sessions, verification and reset tokens, and invite link tokens.
 * Rotating it signs everyone out and turns open invite links off; owners can
 * send those invites again.
 *
 * Fails closed: a hosted process (Vercel, Docker, `next start`) with no
 * BETTER_AUTH_SECRET, or with the public development value, refuses to run.
 * The development value is in this repo, so anyone could forge a verification
 * token with it. Only `next dev` and tests may fall back to it.
 */
export function serverSecret(env: Env = process.env): string {
  const value = env.BETTER_AUTH_SECRET?.trim();
  if (value) {
    if (value === LOCAL_DEV_SECRET && isHosted(env)) {
      throw new ConfigError("BETTER_AUTH_SECRET is the public development value. Set a random secret (openssl rand -base64 32).");
    }
    return value;
  }
  if (isHosted(env)) {
    throw new ConfigError("BETTER_AUTH_SECRET is required. Set a random secret (openssl rand -base64 32).");
  }
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
