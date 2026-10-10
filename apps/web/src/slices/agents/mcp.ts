import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createDollasMcpServer, toolAccess, type DollasMcpServices } from "@dollas/mcp";
import {
  AGENT_MESSAGES,
  agentAccessError,
  agentChallengeScopes,
  decideAgentGrant,
  type AgentAccess,
  type AgentGrant,
  type AgentTokenClaims,
} from "@dollas/domain";
import { getAuth } from "@/lib/auth";
import { protectedResourceMetadataUrl } from "@/lib/agent-oauth";
import { logError, logInfo } from "@/lib/telemetry";
import { loadBooksForMember, type BooksContext } from "@/slices/access/member";
import { addHouseholdAccount } from "@/slices/accounts/service";
import { loadAccounts } from "@/slices/books/queries";
import { agentConnectionIsLive, recordAgentUse } from "@/slices/agents/connections";

/**
 * The authenticated MCP endpoint (Streamable HTTP, stateless, JSON responses).
 *
 * Every request: verify the bearer access token with the OAuth provider, turn
 * it into a member + household grant, confirm the member still has the
 * connection and can still open the household, then run the tool through the
 * same services and RLS (withActor as dollas_app) the web pages use.
 */

type Challenge = {
  status: 401 | 403;
  error?: "invalid_token" | "insufficient_scope";
  description: string;
  scopes: string[];
};

function quote(value: string): string {
  return value.replace(/[\\"]/g, "");
}

/** RFC 6750 / RFC 9728 challenge. */
export function challengeResponse(challenge: Challenge, metadataUrl = protectedResourceMetadataUrl()): Response {
  const parts = [`resource_metadata="${quote(metadataUrl)}"`, `scope="${quote(challenge.scopes.join(" "))}"`];
  if (challenge.error) {
    parts.unshift(`error="${challenge.error}"`, `error_description="${quote(challenge.description)}"`);
  }
  return Response.json(
    { error: challenge.error ?? "invalid_request", error_description: challenge.description },
    {
      status: challenge.status,
      headers: { "WWW-Authenticate": `Bearer ${parts.join(", ")}`, "Cache-Control": "no-store" },
    },
  );
}

function unauthorized(description: string): Response {
  return challengeResponse({ status: 401, error: "invalid_token", description, scopes: agentChallengeScopes() });
}

export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

type JsonRpcMessage = { method?: unknown; params?: { name?: unknown } };

/** The highest access any message in the request needs (tools/call only). */
export function accessNeeded(body: unknown): AgentAccess {
  const messages: unknown[] = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const rpc = message as JsonRpcMessage;
    if (rpc.method !== "tools/call") continue;
    const name = typeof rpc.params?.name === "string" ? rpc.params.name : "";
    if (toolAccess(name) === "write") return "write";
  }
  return "read";
}

export async function verifyAgentToken(token: string): Promise<AgentTokenClaims> {
  const verified = await getAuth().api.verifyAgentAccessToken({ body: { token } });
  return verified.claims as AgentTokenClaims;
}

function bindServices(books: BooksContext, grant: AgentGrant): DollasMcpServices {
  const actor = { userId: books.userId, householdId: books.householdId };
  return {
    async whoami() {
      return {
        ok: true,
        value: {
          member: { name: books.userName, role: books.role },
          household: { name: books.householdName, currency: books.currency, timezone: books.timezone },
          access: grant.access,
        },
      };
    },
    async listAccounts({ includeArchived }) {
      try {
        const accounts = await loadAccounts(books);
        return {
          ok: true,
          value: accounts
            .filter((item) => includeArchived || !item.archivedAt)
            .map((item) => ({
              id: item.id,
              name: item.name,
              type: item.type,
              balanceCents: item.balanceCents,
              archived: Boolean(item.archivedAt),
            })),
        };
      } catch (error) {
        logError(error, { action: "mcp-list-accounts", householdId: books.householdId });
        return { ok: false, message: "Could not load accounts. Try again." };
      }
    },
    async addAccount(input) {
      const added = await addHouseholdAccount(actor, input, "mcp");
      return added.ok ? { ok: true, value: added.value } : { ok: false, message: added.memberMessage };
    },
  };
}

async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false };
  }
}

export async function handleMcpRequest(request: Request): Promise<Response> {
  const token = bearerToken(request.headers.get("authorization"));
  if (!token) {
    return challengeResponse({ status: 401, description: AGENT_MESSAGES.missing_token, scopes: agentChallengeScopes() });
  }

  let claims: AgentTokenClaims;
  try {
    claims = await verifyAgentToken(token);
  } catch (error) {
    logError(error, { action: "mcp-verify-token" });
    return unauthorized(AGENT_MESSAGES.invalid_token);
  }
  const decided = decideAgentGrant(claims);
  if (decided.isErr()) return unauthorized(decided.error.message);
  const grant = decided.value;

  if (!(await agentConnectionIsLive(grant))) return unauthorized(AGENT_MESSAGES.revoked);
  const books = await loadBooksForMember(grant.userId, grant.householdId);
  if (!books) return unauthorized(agentAccessError("invalid_token").message);

  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  const parsed = await readJson(request);
  if (!parsed.ok) {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400 },
    );
  }
  const needed = accessNeeded(parsed.body);
  if (needed === "write" && grant.access !== "write") {
    logInfo("Agent tried a write tool with a read-only grant", {
      action: "mcp-insufficient-scope",
      userId: grant.userId,
      clientId: grant.clientId,
    });
    return challengeResponse({
      status: 403,
      error: "insufficient_scope",
      description: AGENT_MESSAGES.insufficient_scope,
      scopes: agentChallengeScopes(),
    });
  }

  await recordAgentUse(grant);
  const server = createDollasMcpServer(grant, bindServices(books, grant));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request, {
      parsedBody: parsed.body,
      authInfo: { token, clientId: grant.clientId, scopes: [...grant.scopes] },
    });
    const methods = (Array.isArray(parsed.body) ? parsed.body : [parsed.body])
      .map((message) => (message && typeof message === "object" ? String((message as JsonRpcMessage).method ?? "") : ""))
      .join(",");
    logInfo("MCP request", {
      action: "mcp-request",
      userId: grant.userId,
      householdId: grant.householdId,
      clientId: grant.clientId,
      methods,
      status: String(response.status),
    });
    return response;
  } finally {
    await server.close();
  }
}
