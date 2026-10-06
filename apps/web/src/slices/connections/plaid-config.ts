import { resolvePlaidConfig } from "@dollas/domain";
import { logError } from "@/lib/telemetry";

type Env = Record<string, string | undefined>;

let reportedIncompletePlaid = false;

export function readPlaidEnv(env: Env = process.env) {
  return {
    clientId: env.PLAID_CLIENT_ID ?? "",
    secret: env.PLAID_SECRET ?? "",
    env: env.PLAID_ENV ?? "",
    redirectUri: env.PLAID_REDIRECT_URI ?? "",
  };
}

/**
 * Server decision. The client receives only this boolean, never the credentials.
 * A partial or invalid setup is logged once. Members do not see the variable names.
 */
export function plaidLinkEnabled(env: Env = process.env): boolean {
  const decision = resolvePlaidConfig(readPlaidEnv(env));
  if (decision.isErr()) {
    if (!reportedIncompletePlaid) {
      reportedIncompletePlaid = true;
      logError(decision.error, { action: "plaid-link" });
    }
    return false;
  }
  return decision.value.enabled;
}
