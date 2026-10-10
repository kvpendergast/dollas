import {
  AGENT_MESSAGES,
  AGENT_WRITE_SCOPE,
  AgentAccessError,
  describeAgentAccess,
  memberFacingMessage,
  requestedAgentScopes,
  type AgentGrant,
} from "@dollas/domain";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { withActor } from "@/db/actor";
import { agentActivity, oauthAccessToken, oauthClient, oauthConsent, oauthRefreshToken } from "@/db/schema";
import { logError, logInfo } from "@/lib/telemetry";

/**
 * Connected-agent services.
 *
 * UI-only (the member manages agents in Settings; no MCP tool may call these,
 * so one agent can never list or disconnect another):
 *   listAgentConnections, revokeAgentConnection, describeAgentRequest.
 * Called by the MCP endpoint for every request (not tools):
 *   agentConnectionIsLive, recordAgentUse.
 *
 * The oauth_* tables have no household RLS (the OAuth plugin writes them before
 * a household is known), so every query here filters by the member and the
 * household explicitly. agent_activity does have RLS.
 */
export type AgentActor = {
  userId: string;
  householdId: string;
};

export type AgentConnection = {
  id: string;
  clientId: string;
  clientName: string;
  access: string;
  scopes: string[];
  connectedAt: Date | null;
  lastUsedAt: Date | null;
};

export type AgentResult<T> = { ok: true; value: T } | { ok: false; error: unknown; memberMessage: string };

const LIST_FAILED = "Could not load connected agents. Refresh the page to try again.";
const REVOKE_FAILED = "Could not disconnect that agent. Try again.";
const NOT_FOUND = "That agent is not connected to your login.";

/** Last-used is written at most once a minute per agent. */
const ACTIVITY_THROTTLE_SECONDS = 60;

function clientLabel(name: string | null, clientId: string): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed.slice(0, 80);
  return `Agent ${clientId.slice(0, 8)}`;
}

function failed<T>(error: unknown, fallback: string, action: string, actor: AgentActor): AgentResult<T> {
  logError(error, { action, userId: actor.userId, householdId: actor.householdId });
  return { ok: false, error, memberMessage: error instanceof AgentAccessError ? error.message : memberFacingMessage(error, fallback) };
}

export async function listAgentConnections(actor: AgentActor): Promise<AgentResult<AgentConnection[]>> {
  try {
    const rows = await withActor(actor.userId, async (tx) => {
      const consents = await tx
        .select({
          id: oauthConsent.id,
          clientId: oauthConsent.clientId,
          clientName: oauthClient.name,
          scopes: oauthConsent.scopes,
          createdAt: oauthConsent.createdAt,
          updatedAt: oauthConsent.updatedAt,
        })
        .from(oauthConsent)
        .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
        .where(and(eq(oauthConsent.userId, actor.userId), eq(oauthConsent.referenceId, actor.householdId)))
        .orderBy(desc(oauthConsent.createdAt));
      const activity = await tx
        .select({ clientId: agentActivity.clientId, lastUsedAt: agentActivity.lastUsedAt })
        .from(agentActivity)
        .where(and(eq(agentActivity.userId, actor.userId), eq(agentActivity.householdId, actor.householdId)));
      const used = new Map(activity.map((row) => [row.clientId, row.lastUsedAt]));
      return consents.map((row) => ({
        id: row.id,
        clientId: row.clientId,
        clientName: clientLabel(row.clientName, row.clientId),
        access: describeAgentAccess(row.scopes),
        scopes: row.scopes,
        connectedAt: row.createdAt,
        lastUsedAt: used.get(row.clientId) ?? null,
      }));
    });
    return { ok: true, value: rows };
  } catch (error) {
    return failed(error, LIST_FAILED, "list-agent-connections", actor);
  }
}

/**
 * Disconnects one agent immediately: the consent is deleted and every access
 * and refresh token the agent holds for this member and household is revoked
 * in the same transaction. The next MCP call gets a 401.
 */
export async function revokeAgentConnection(
  actor: AgentActor,
  consentId: string,
): Promise<AgentResult<{ clientName: string; revokedTokens: number }>> {
  try {
    const outcome = await withActor(actor.userId, async (tx) => {
      const [consent] = await tx
        .select({ id: oauthConsent.id, clientId: oauthConsent.clientId, clientName: oauthClient.name })
        .from(oauthConsent)
        .innerJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
        .where(
          and(
            eq(oauthConsent.id, consentId),
            eq(oauthConsent.userId, actor.userId),
            eq(oauthConsent.referenceId, actor.householdId),
          ),
        );
      if (!consent) return null;
      const now = new Date();
      const owned = (table: typeof oauthAccessToken | typeof oauthRefreshToken) =>
        and(
          eq(table.userId, actor.userId),
          eq(table.clientId, consent.clientId),
          eq(table.referenceId, actor.householdId),
          isNull(table.revoked),
        );
      const access = await tx
        .update(oauthAccessToken)
        .set({ revoked: now })
        .where(owned(oauthAccessToken))
        .returning({ id: oauthAccessToken.id });
      const refresh = await tx
        .update(oauthRefreshToken)
        .set({ revoked: now })
        .where(owned(oauthRefreshToken))
        .returning({ id: oauthRefreshToken.id });
      await tx.delete(oauthConsent).where(eq(oauthConsent.id, consent.id));
      await tx
        .delete(agentActivity)
        .where(
          and(
            eq(agentActivity.userId, actor.userId),
            eq(agentActivity.householdId, actor.householdId),
            eq(agentActivity.clientId, consent.clientId),
          ),
        );
      return {
        clientId: consent.clientId,
        clientName: clientLabel(consent.clientName, consent.clientId),
        revokedTokens: access.length + refresh.length,
      };
    });
    if (!outcome) return { ok: false, error: new Error("agent connection not found"), memberMessage: NOT_FOUND };
    logInfo("Agent disconnected", {
      action: "revoke-agent-connection",
      userId: actor.userId,
      householdId: actor.householdId,
      clientId: outcome.clientId,
      revokedTokens: String(outcome.revokedTokens),
    });
    return { ok: true, value: { clientName: outcome.clientName, revokedTokens: outcome.revokedTokens } };
  } catch (error) {
    return failed(error, REVOKE_FAILED, "revoke-agent-connection", actor);
  }
}

/** The member still has a consent for this agent in this household. */
export async function agentConnectionIsLive(grant: AgentGrant): Promise<boolean> {
  const rows = await withActor(grant.userId, (tx) =>
    tx
      .select({ id: oauthConsent.id })
      .from(oauthConsent)
      .where(
        and(
          eq(oauthConsent.userId, grant.userId),
          eq(oauthConsent.clientId, grant.clientId),
          eq(oauthConsent.referenceId, grant.householdId),
        ),
      )
      .limit(1),
  );
  return rows.length > 0;
}

export async function recordAgentUse(grant: AgentGrant): Promise<void> {
  try {
    await withActor(grant.userId, (tx) =>
      tx
        .insert(agentActivity)
        .values({ householdId: grant.householdId, userId: grant.userId, clientId: grant.clientId })
        .onConflictDoUpdate({
          target: [agentActivity.householdId, agentActivity.userId, agentActivity.clientId],
          set: { lastUsedAt: sql`now()` },
          setWhere: lt(agentActivity.lastUsedAt, sql`now() - make_interval(secs => ${ACTIVITY_THROTTLE_SECONDS})`),
        }),
    );
  } catch (error) {
    logError(error, { action: "record-agent-use", userId: grant.userId, clientId: grant.clientId });
  }
}

export type AgentRequest = {
  clientId: string;
  clientName: string;
  clientUri: string | null;
  requestedScopes: string[];
  canWrite: boolean;
};

/** What the consent screen shows about the agent asking to connect. */
export async function describeAgentRequest(
  userId: string,
  query: URLSearchParams,
): Promise<AgentResult<AgentRequest>> {
  const clientId = query.get("client_id") ?? "";
  try {
    const [client] = await withActor(userId, (tx) =>
      tx
        .select({ clientId: oauthClient.clientId, name: oauthClient.name, uri: oauthClient.uri, disabled: oauthClient.disabled })
        .from(oauthClient)
        .where(eq(oauthClient.clientId, clientId)),
    );
    if (!client || client.disabled) {
      return { ok: false, error: new Error("unknown client"), memberMessage: AGENT_MESSAGES.invalid_token };
    }
    const requestedScopes = requestedAgentScopes(query.get("scope"));
    return {
      ok: true,
      value: {
        clientId: client.clientId,
        clientName: clientLabel(client.name, client.clientId),
        clientUri: client.uri,
        requestedScopes,
        canWrite: requestedScopes.includes(AGENT_WRITE_SCOPE),
      },
    };
  } catch (error) {
    return failed(error, "Could not load this agent. Start the connection again from the agent.", "describe-agent-request", {
      userId,
      householdId: "",
    });
  }
}
