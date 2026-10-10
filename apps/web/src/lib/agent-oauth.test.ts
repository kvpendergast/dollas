import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentAuthorizeReturnPath,
  isAgentAuthorizePath,
  isAgentLoginQuery,
  protectedResourceMetadata,
  registrationWithNativeDefault,
} from "./agent-oauth";
import { accessNeeded, bearerToken, challengeResponse } from "../slices/agents/mcp";

const signed =
  "response_type=code&client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A9%2Fcb&scope=dollas%3Aread&state=s&code_challenge=c&code_challenge_method=S256&prompt=login+consent&exp=1&ba_iat=2&ba_param=client_id&sig=zzz";

describe("agent sign-in return path", () => {
  it("strips the signature and login prompt and only targets the provider's authorize path", () => {
    const path = agentAuthorizeReturnPath(signed);
    assert.ok(path);
    assert.ok(path.startsWith("/api/auth/oauth2/authorize?"));
    const params = new URLSearchParams(path.split("?")[1]);
    assert.equal(params.get("client_id"), "abc");
    assert.equal(params.get("prompt"), "consent");
    for (const key of ["sig", "exp", "ba_iat", "ba_param"]) assert.equal(params.has(key), false);
    assert.equal(isAgentAuthorizePath(path), true);
  });

  it("refuses anything that is not an authorization request", () => {
    assert.equal(agentAuthorizeReturnPath(""), null);
    assert.equal(agentAuthorizeReturnPath("client_id=abc"), null);
    assert.equal(isAgentAuthorizePath("https://evil.example/api/auth/oauth2/authorize?client_id=a"), false);
    assert.equal(isAgentAuthorizePath("/api/auth/oauth2/authorize?client_id=a&sig=x"), false);
    assert.equal(isAgentAuthorizePath("/"), false);
  });

  it("recognizes the provider's login redirect", () => {
    assert.equal(isAgentLoginQuery({ client_id: "a", sig: "s", response_type: "code" }), true);
    assert.equal(isAgentLoginQuery({ client_id: "a", response_type: "code" }), false);
    assert.equal(isAgentLoginQuery({ invite: "x" }), false);
  });
});

describe("dynamic registration default", () => {
  it("marks loopback public clients native and leaves others alone", () => {
    assert.equal(
      registrationWithNativeDefault({ redirect_uris: ["http://127.0.0.1:6274/oauth/callback", "http://localhost:3/cb"] })
        ?.application_type,
      "native",
    );
    assert.equal(registrationWithNativeDefault({ redirect_uris: ["https://app.example/cb"] }), null);
    assert.equal(registrationWithNativeDefault({ redirect_uris: ["http://localhost/cb", "https://x.example/cb"] }), null);
    assert.equal(registrationWithNativeDefault({ redirect_uris: ["http://localhost/cb"], application_type: "web" }), null);
    assert.equal(registrationWithNativeDefault({ redirect_uris: ["http://localhost.evil.example/cb"] }), null);
  });
});

describe("MCP request helpers", () => {
  it("reads bearer tokens", () => {
    assert.equal(bearerToken("Bearer dollas_at_abc"), "dollas_at_abc");
    assert.equal(bearerToken("bearer   xyz "), "xyz");
    assert.equal(bearerToken("Basic abc"), null);
    assert.equal(bearerToken(null), null);
  });

  it("finds write tools in single and batched calls", () => {
    assert.equal(accessNeeded({ method: "tools/call", params: { name: "list_accounts" } }), "read");
    assert.equal(accessNeeded({ method: "tools/call", params: { name: "create_account" } }), "write");
    assert.equal(accessNeeded([{ method: "tools/list" }, { method: "tools/call", params: { name: "create_account" } }]), "write");
    assert.equal(accessNeeded({ method: "tools/call", params: { name: "constructor" } }), "read");
  });

  it("builds RFC 6750 and RFC 9728 challenges", async () => {
    const response = challengeResponse(
      { status: 403, error: "insufficient_scope", description: "needs write", scopes: ["dollas:read", "dollas:write"] },
      "https://d.example/.well-known/oauth-protected-resource/api/mcp",
    );
    assert.equal(response.status, 403);
    assert.equal(
      response.headers.get("www-authenticate"),
      'Bearer error="insufficient_scope", error_description="needs write", resource_metadata="https://d.example/.well-known/oauth-protected-resource/api/mcp", scope="dollas:read dollas:write"',
    );
    assert.deepEqual(await response.json(), { error: "insufficient_scope", error_description: "needs write" });
  });

  it("publishes protected resource metadata for the MCP endpoint", () => {
    assert.deepEqual(protectedResourceMetadata("https://d.example"), {
      resource: "https://d.example/api/mcp",
      authorization_servers: ["https://d.example/api/auth"],
      scopes_supported: ["dollas:read", "dollas:write", "offline_access"],
      bearer_methods_supported: ["header"],
      resource_name: "Dollas",
      resource_documentation: "https://d.example/settings",
    });
  });
});
