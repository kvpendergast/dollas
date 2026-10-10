import { err, ok, type Result } from "neverthrow";
import { AgentAccessError, type AgentAccessFailureReason } from "../errors";

/**
 * Agent (MCP) access rules. Dollas is the OAuth authorization server; these
 * functions hold the decisions that do not depend on the OAuth library:
 * which scopes exist, what a member may grant, and whether a verified token
 * may run a given tool.
 */

/** Read household books. Every agent connection includes it. */
export const AGENT_READ_SCOPE = "dollas:read";
/** Change household books. Only granted when the member picks read and write. */
export const AGENT_WRITE_SCOPE = "dollas:write";
/** Lets the agent refresh its short-lived access token without the member. */
export const AGENT_REFRESH_SCOPE = "offline_access";

export const AGENT_SCOPES = [AGENT_READ_SCOPE, AGENT_WRITE_SCOPE, AGENT_REFRESH_SCOPE] as const;

/** 15 minutes. Agents refresh; a leaked access token dies quickly. */
export const AGENT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
/** 30 days. Each use rotates it; reusing a rotated one kills the family. */
export const AGENT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export type AgentAccess = "read" | "write";

/** What the member picks on the consent screen. */
export type AgentScopeChoice = "read" | "read_write";

/** A verified access token, reduced to what a tool call needs. */
export type AgentGrant = {
  userId: string;
  householdId: string;
  clientId: string;
  access: AgentAccess;
  scopes: readonly string[];
};

/** Introspection-shaped payload the OAuth library returns for an access token. */
export type AgentTokenClaims = {
  active?: unknown;
  sub?: unknown;
  client_id?: unknown;
  scope?: unknown;
  household_id?: unknown;
};

export const AGENT_MESSAGES: Record<AgentAccessFailureReason, string> = {
  missing_token: "Connect this agent to Dollas first. It needs to sign in through Dollas.",
  invalid_token: "This agent's Dollas access has expired or was disconnected. Connect it again.",
  no_household: "Start or join a household in Dollas before connecting an agent.",
  insufficient_scope: "This agent can only read your household. Reconnect it with read and write access to make changes.",
  revoked: "This agent was disconnected in Dollas Settings. Connect it again to use it.",
  invalid_scope_choice: "Pick read, or read and write.",
};

export function agentAccessError(reason: AgentAccessFailureReason): AgentAccessError {
  return new AgentAccessError(reason, AGENT_MESSAGES[reason]);
}

function splitScopes(scope: unknown): string[] {
  if (typeof scope !== "string") return [];
  return scope.split(/\s+/).filter((item) => item.length > 0);
}

export function accessFromScopes(scopes: readonly string[]): AgentAccess | null {
  if (!scopes.includes(AGENT_READ_SCOPE)) return null;
  return scopes.includes(AGENT_WRITE_SCOPE) ? "write" : "read";
}

/**
 * Scopes to grant for the member's choice. The agent cannot gain a scope it
 * did not request, and the member cannot be talked into write by a client
 * that asked only for read. Refresh is kept when the client asked for it.
 */
export function grantedScopesFor(
  requested: readonly string[],
  choice: string,
): Result<string[], AgentAccessError> {
  if (choice !== "read" && choice !== "read_write") return err(agentAccessError("invalid_scope_choice"));
  if (!requested.includes(AGENT_READ_SCOPE)) return err(agentAccessError("invalid_scope_choice"));
  const granted = [AGENT_READ_SCOPE];
  if (choice === "read_write") {
    if (!requested.includes(AGENT_WRITE_SCOPE)) return err(agentAccessError("invalid_scope_choice"));
    granted.push(AGENT_WRITE_SCOPE);
  }
  if (requested.includes(AGENT_REFRESH_SCOPE)) granted.push(AGENT_REFRESH_SCOPE);
  return ok(granted);
}

/**
 * A client that registered without naming scopes still asks for read, so the
 * consent screen always has something to show. Unknown scopes are dropped.
 */
export function requestedAgentScopes(scope: unknown): string[] {
  const known = new Set<string>(AGENT_SCOPES);
  const asked = splitScopes(scope).filter((item) => known.has(item));
  return asked.length > 0 ? asked : [AGENT_READ_SCOPE];
}

/**
 * Turns verified token claims into a grant. Rejects inactive tokens, tokens
 * with no member or household, and tokens without the read scope.
 */
export function decideAgentGrant(claims: AgentTokenClaims): Result<AgentGrant, AgentAccessError> {
  if (claims.active !== true) return err(agentAccessError("invalid_token"));
  if (typeof claims.sub !== "string" || claims.sub.length === 0) return err(agentAccessError("invalid_token"));
  if (typeof claims.client_id !== "string" || claims.client_id.length === 0) {
    return err(agentAccessError("invalid_token"));
  }
  if (typeof claims.household_id !== "string" || claims.household_id.length === 0) {
    return err(agentAccessError("no_household"));
  }
  const scopes = splitScopes(claims.scope);
  const access = accessFromScopes(scopes);
  if (!access) return err(agentAccessError("insufficient_scope"));
  return ok({
    userId: claims.sub,
    householdId: claims.household_id,
    clientId: claims.client_id,
    access,
    scopes,
  });
}

/** Write tools need the write scope. Read tools need only a valid grant. */
export function requireAgentAccess(grant: AgentGrant, needed: AgentAccess): Result<AgentGrant, AgentAccessError> {
  if (needed === "write" && grant.access !== "write") return err(agentAccessError("insufficient_scope"));
  return ok(grant);
}

/**
 * Scopes to name in a 401 challenge or a 403 step-up. MCP clients request
 * exactly what the challenge names, and the member narrows it on the consent
 * screen, so the challenge asks for everything an agent could be given and
 * the member decides read, or read and write. A step-up must include write.
 */
export function agentChallengeScopes(): string[] {
  return [AGENT_READ_SCOPE, AGENT_WRITE_SCOPE, AGENT_REFRESH_SCOPE];
}

/** Label for Settings. */
export function describeAgentAccess(scopes: readonly string[]): string {
  const access = accessFromScopes(scopes);
  if (access === "write") return "Read and write";
  if (access === "read") return "Read only";
  return "No access";
}
