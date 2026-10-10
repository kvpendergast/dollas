"use server";

import { AGENT_MESSAGES, grantedScopesFor, requestedAgentScopes } from "@dollas/domain";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth";
import { siteOrigin } from "@/lib/server-secret";
import { logError, logInfo } from "@/lib/telemetry";
import { requireBooks, requireVerifiedUser } from "@/slices/access/guard";
import { agentHouseholdFor } from "@/slices/access/member";
import { revokeAgentConnection } from "@/slices/agents/connections";

export type AgentFormState = { error: string; notice?: string };

const CONSENT_FAILED = "Could not finish connecting. Start the connection again from the agent.";

type ConsentBody = { accept: boolean; scope?: string; oauth_query: string };

/**
 * Posts the decision to the provider's /oauth2/consent as the member's
 * browser would (same cookies), because the provider re-runs authorization
 * and needs a real request. Asking for JSON returns the client redirect URL.
 */
async function submitConsent(body: ConsentBody): Promise<unknown> {
  const incoming = await headers();
  const forward = new Headers({ "content-type": "application/json", accept: "application/json", origin: siteOrigin() });
  const cookie = incoming.get("cookie");
  if (cookie) forward.set("cookie", cookie);
  const agent = incoming.get("user-agent");
  if (agent) forward.set("user-agent", agent);
  const forwardedFor = incoming.get("x-forwarded-for");
  if (forwardedFor) forward.set("x-forwarded-for", forwardedFor);
  const response = await getAuth().handler(
    new Request(`${siteOrigin()}/api/auth/oauth2/consent`, { method: "POST", headers: forward, body: JSON.stringify(body) }),
  );
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`consent failed with ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function redirectTarget(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const record = result as { url?: unknown; redirect_uri?: unknown };
  if (typeof record.url === "string") return record.url;
  if (typeof record.redirect_uri === "string") return record.redirect_uri;
  return null;
}

/**
 * Consent screen submit. The member confirms their household and picks read,
 * or read and write. The OAuth provider checks the signed query, records the
 * consent against the household, and returns the client's redirect with a code.
 */
export async function connectAgentAction(_state: AgentFormState, formData: FormData): Promise<AgentFormState> {
  const ctx = await requireVerifiedUser();
  const oauthQuery = String(formData.get("oauth_query") ?? "");
  const decision = String(formData.get("decision") ?? "");
  const query = new URLSearchParams(oauthQuery);
  let target: string | null = null;
  try {
    if (decision === "deny") {
      const denied = await submitConsent({ accept: false, oauth_query: oauthQuery });
      target = redirectTarget(denied);
    } else {
      const books = await agentHouseholdFor(ctx.actor.userId);
      if (!books) return { error: AGENT_MESSAGES.no_household };
      const granted = grantedScopesFor(requestedAgentScopes(query.get("scope")), String(formData.get("access") ?? ""));
      if (granted.isErr()) return { error: granted.error.message };
      const accepted = await submitConsent({ accept: true, scope: granted.value.join(" "), oauth_query: oauthQuery });
      target = redirectTarget(accepted);
      logInfo("Agent connected", {
        action: "connect-agent",
        userId: ctx.actor.userId,
        householdId: books.householdId,
        clientId: query.get("client_id") ?? "",
        scopes: granted.value.join(" "),
      });
    }
  } catch (error) {
    logError(error, { action: "connect-agent", userId: ctx.actor.userId });
    return { error: CONSENT_FAILED };
  }
  if (!target) return { error: CONSENT_FAILED };
  redirect(target);
}

export async function revokeAgentAction(_state: AgentFormState, formData: FormData): Promise<AgentFormState> {
  const books = await requireBooks();
  const revoked = await revokeAgentConnection(
    { userId: books.userId, householdId: books.householdId },
    String(formData.get("connectionId") ?? ""),
  );
  if (!revoked.ok) return { error: revoked.memberMessage };
  revalidatePath("/settings");
  return { error: "", notice: `${revoked.value.clientName} is disconnected.` };
}
