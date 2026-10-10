import { getOAuthProviderApi, type OAuthOptions, type Scope } from "@better-auth/oauth-provider";
import {
  AGENT_ACCESS_TOKEN_TTL_SECONDS,
  AGENT_READ_SCOPE,
  AGENT_REFRESH_SCOPE,
  AGENT_REFRESH_TOKEN_TTL_SECONDS,
  AGENT_SCOPES,
  AGENT_WRITE_SCOPE,
} from "@dollas/domain";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
import { z } from "zod";
import { siteOrigin } from "@/lib/server-secret";
import { logError } from "@/lib/telemetry";
import { agentHouseholdFor } from "@/slices/access/member";

/**
 * Dollas as an OAuth 2.1 authorization server for agents (MCP clients),
 * built on @better-auth/oauth-provider.
 *
 * - Authorization code with PKCE. The plugin accepts S256 only, and public
 *   clients (what MCP clients register as) always need PKCE.
 * - Opaque access tokens (no JWT plugin) so every token is a hashed row that
 *   revocation can kill. 15-minute access tokens, 30-day refresh tokens that
 *   rotate on every use; reusing a rotated refresh token revokes the family.
 * - The consent's reference id is the member's household. Tokens carry it as
 *   the `household_id` claim and the MCP endpoint re-checks membership.
 * - Open dynamic client registration (RFC 7591), which MCP clients expect.
 */

export const AUTH_BASE_PATH = "/api/auth";
export const MCP_PATH = "/api/mcp";
export const CONSENT_PATH = "/connect-agent";

/** RFC 8707 resource identifier for the MCP endpoint. */
export function mcpResourceUrl(origin = siteOrigin()): string {
  return `${origin}${MCP_PATH}`;
}

/** Better Auth's base URL, which is the issuer when the JWT plugin is off. */
export function authIssuer(origin = siteOrigin()): string {
  return `${origin}${AUTH_BASE_PATH}`;
}

/** RFC 9728 metadata URL for the MCP resource (path-suffixed form). */
export function protectedResourceMetadataUrl(origin = siteOrigin()): string {
  return `${origin}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

const SCOPES: Scope[] = [...AGENT_SCOPES];

export function agentOAuthOptions(): OAuthOptions<Scope[]> {
  return {
    loginPage: "/sign-in",
    consentPage: CONSENT_PATH,
    scopes: SCOPES,
    advertisedMetadata: { scopes_supported: SCOPES },
    grantTypes: ["authorization_code", "refresh_token"],
    accessTokenExpiresIn: AGENT_ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenExpiresIn: AGENT_REFRESH_TOKEN_TTL_SECONDS,
    refreshTokenReuseInterval: 0,
    disableJwtPlugin: true,
    storeClientSecret: "encrypted",
    storeTokens: "hashed",
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    clientRegistrationDefaultScopes: [AGENT_READ_SCOPE, AGENT_WRITE_SCOPE, AGENT_REFRESH_SCOPE],
    clientRegistrationAllowedScopes: SCOPES,
    clientRegistrationRequirePKCE: true,
    resources: [
      {
        identifier: mcpResourceUrl(),
        name: "Dollas MCP",
        allowedScopes: SCOPES,
      },
    ],
    resourceSeedMode: "merge",
    // Any registered agent may ask for the one MCP resource.
    enforcePerClientResources: false,
    prefix: {
      opaqueAccessToken: "dollas_at_",
      refreshToken: "dollas_rt_",
    },
    postLogin: {
      page: CONSENT_PATH,
      // The consent page shows the household; there is nothing to pick.
      shouldRedirect: () => false,
      consentReferenceId: async ({ user }) => {
        const books = await agentHouseholdFor(user.id);
        return books?.householdId;
      },
    },
    customAccessTokenClaims: ({ referenceId }) => (referenceId ? { household_id: referenceId } : {}),
  };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * MCP clients (Claude, the MCP Inspector, IDEs) register an http://localhost
 * callback and usually omit `application_type`, which RFC 7591 defaults to
 * "web", and the provider refuses loopback redirects for web clients. A public
 * client whose every redirect is plain-http loopback is a native app (RFC 8252),
 * so mark it as one. Anything else is left for the provider to judge.
 */
export function registrationWithNativeDefault(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const request = body as Record<string, unknown>;
  if (request.application_type !== undefined) return null;
  const uris = request.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) return null;
  const allLoopback = uris.every((uri) => {
    if (typeof uri !== "string") return false;
    try {
      const url = new URL(uri);
      return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
    } catch {
      return false;
    }
  });
  if (!allLoopback) return null;
  return { ...request, application_type: "native" };
}

/**
 * Companion plugin. Adds a server-only endpoint (not reachable over HTTP)
 * that verifies an access token with the provider's own validator: hash
 * lookup, expiry, revocation, client and session checks. Returns
 * introspection-shaped claims. Also applies the native-client default above.
 */
export function agentTokenVerifier(options: OAuthOptions<Scope[]>) {
  return {
    id: "dollas-agent-token",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/oauth2/register",
          handler: createAuthMiddleware(async (ctx) => {
            const body = registrationWithNativeDefault(ctx.body);
            if (body) return { context: { body } };
          }),
        },
      ],
    },
    endpoints: {
      verifyAgentAccessToken: createAuthEndpoint.serverOnly(
        {
          method: "POST",
          body: z.object({ token: z.string().min(1) }),
        },
        async (ctx) => {
          try {
            const payload = await getOAuthProviderApi(ctx, options).validateAccessToken(ctx.body.token);
            return ctx.json({ claims: payload as Record<string, unknown> });
          } catch (error) {
            // Unknown or malformed tokens throw; anything else is worth a log line.
            if (!(error instanceof Error && /not found|invalid/i.test(error.message))) {
              logError(error, { action: "verify-agent-token" });
            }
            return ctx.json({ claims: { active: false } as Record<string, unknown> });
          }
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}

const SIGNED_QUERY_KEYS = new Set(["sig", "exp", "ba_iat", "ba_param", "ba_pl"]);

/**
 * Where to send a member after they sign in during an agent connection.
 * The login page receives the provider's signed authorization query; this
 * strips the signature fields and the `login` prompt so the provider re-runs
 * the original request with the new session. Only ever returns the provider's
 * authorize path, so it cannot become an open redirect.
 */
export function agentAuthorizeReturnPath(rawQuery: string | null | undefined): string | null {
  if (!rawQuery) return null;
  const params = new URLSearchParams(rawQuery.startsWith("?") ? rawQuery.slice(1) : rawQuery);
  const clientId = params.get("client_id");
  if (!clientId || params.get("response_type") !== "code" || !params.get("redirect_uri")) return null;
  const next = new URLSearchParams();
  for (const [key, value] of params.entries()) {
    if (SIGNED_QUERY_KEYS.has(key)) continue;
    if (key === "prompt") {
      const kept = value
        .split(" ")
        .filter((item) => item && item !== "login" && item !== "create")
        .join(" ");
      if (kept) next.append(key, kept);
      continue;
    }
    next.append(key, value);
  }
  return `${AUTH_BASE_PATH}/oauth2/authorize?${next.toString()}`;
}

/** Only the provider's own authorize path counts as an agent return path. */
export function isAgentAuthorizePath(path: string): boolean {
  if (!path.startsWith(`${AUTH_BASE_PATH}/oauth2/authorize?`)) return false;
  return agentAuthorizeReturnPath(path.slice(path.indexOf("?") + 1)) === path;
}

/** True when the sign-in page was opened by the provider for an agent connection. */
export function isAgentLoginQuery(params: Record<string, string | string[] | undefined>): boolean {
  return typeof params.client_id === "string" && typeof params.sig === "string" && params.response_type === "code";
}

/** Query string from Next search params, preserving repeated keys. */
export function searchParamsToQuery(params: Record<string, string | string[] | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) for (const item of value) query.append(key, item);
    else if (typeof value === "string") query.append(key, value);
  }
  return query.toString();
}

/** RFC 9728 protected resource metadata for the MCP endpoint. */
export function protectedResourceMetadata(origin = siteOrigin()) {
  return {
    resource: mcpResourceUrl(origin),
    authorization_servers: [authIssuer(origin)],
    scopes_supported: [...AGENT_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Dollas",
    resource_documentation: `${origin}/settings`,
  };
}
