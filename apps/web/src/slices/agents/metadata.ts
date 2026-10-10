import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import { getAuth } from "@/lib/auth";
import { protectedResourceMetadata } from "@/lib/agent-oauth";

/**
 * Discovery documents MCP clients fetch before connecting:
 * - /.well-known/oauth-protected-resource[/api/mcp] (RFC 9728) names the
 *   authorization server and scopes for the MCP endpoint.
 * - /.well-known/oauth-authorization-server[/api/auth] (RFC 8414) comes from
 *   the OAuth provider plugin: endpoints, PKCE S256, registration.
 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=300",
};

export function protectedResourceMetadataResponse(): Response {
  return Response.json(protectedResourceMetadata(), { headers: CORS });
}

export function authorizationServerMetadataResponse(request: Request): Promise<Response> {
  return oauthProviderAuthServerMetadata(getAuth(), { headers: CORS })(request);
}
