/**
 * Scripted MCP client for a local Dollas (`pnpm dev`). It runs the real OAuth
 * flow (dynamic registration, PKCE S256, sign-in, consent, token exchange)
 * and then talks to /api/mcp over Streamable HTTP with the MCP SDK client.
 *
 *   pnpm --filter @dollas/web mcp:local tools
 *   pnpm --filter @dollas/web mcp:local call list_accounts
 *   pnpm --filter @dollas/web mcp:local call set_budget '{"category_id":"…","amount_cents":50000}'
 *   pnpm --filter @dollas/web mcp:local call commit_csv_import @args.json
 *
 * Env: DOLLAS_URL (default http://localhost:3000), DOLLAS_EMAIL and
 * DOLLAS_PASSWORD (default: the seeded demo login), DOLLAS_ACCESS=read|write
 * (default write). Local development only: it posts consent directly instead
 * of clicking through /connect-agent, and it refuses non-loopback URLs.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = (process.env.DOLLAS_URL ?? "http://localhost:3000").replace(/\/$/, "");
const EMAIL = process.env.DOLLAS_EMAIL ?? "ada@maple.local";
const PASSWORD = process.env.DOLLAS_PASSWORD ?? "maple-demo";
const ACCESS = process.env.DOLLAS_ACCESS === "read" ? "read" : "write";
const REDIRECT = "http://127.0.0.1:7777/callback";
/** Client id and rotating refresh token, so repeated runs do not re-register (registration is rate limited). */
const CACHE = join(tmpdir(), "dollas-mcp-local.json");

type Cached = { key: string; clientId: string; refreshToken?: string };

function readCache(key: string): Cached | null {
  try {
    const cached = JSON.parse(readFileSync(CACHE, "utf8")) as Cached;
    return cached.key === key ? cached : null;
  } catch {
    return null;
  }
}

function writeCache(cached: Cached) {
  writeFileSync(CACHE, JSON.stringify(cached), { mode: 0o600 });
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function json<T>(response: Response, what: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) fail(`${what} failed (${response.status}): ${text}`);
  return JSON.parse(text) as T;
}

async function accessToken(): Promise<string> {
  const host = new URL(BASE).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) fail("mcp-local only talks to a local Dollas.");
  const headers = { "content-type": "application/json", origin: BASE };

  const resource = await json<{ resource: string; authorization_servers: string[] }>(
    await fetch(`${BASE}/.well-known/oauth-protected-resource/api/mcp`),
    "protected resource metadata",
  );
  const issuer = resource.authorization_servers[0] ?? fail("no authorization server");
  const metadata = await json<{ registration_endpoint: string; authorization_endpoint: string; token_endpoint: string }>(
    await fetch(`${BASE}/.well-known/oauth-authorization-server${new URL(issuer).pathname}`),
    "authorization server metadata",
  );

  const key = `${BASE} ${EMAIL} ${ACCESS}`;
  const cached = readCache(key);
  if (cached?.refreshToken) {
    const refreshed = await fetch(metadata.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: cached.refreshToken, client_id: cached.clientId }).toString(),
    });
    if (refreshed.ok) {
      const tokens = (await refreshed.json()) as { access_token: string; refresh_token?: string };
      writeCache({ key, clientId: cached.clientId, refreshToken: tokens.refresh_token });
      return tokens.access_token;
    }
  }

  const client = cached ? { client_id: cached.clientId } : await json<{ client_id: string }>(
    await fetch(metadata.registration_endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        client_name: "mcp-local script",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }),
    "client registration",
  );
  writeCache({ key, clientId: client.client_id });

  const signIn = await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  await json(signIn, "sign-in");
  const cookie = signIn.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const scope = ACCESS === "write" ? "dollas:read dollas:write offline_access" : "dollas:read offline_access";
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    scope,
    state: randomBytes(8).toString("hex"),
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: resource.resource,
  });
  const authorize = await fetch(`${metadata.authorization_endpoint}?${query}`, { headers: { cookie }, redirect: "manual" });
  const location = authorize.headers.get("location") ?? (await authorize.json().catch(() => ({})) as { url?: string }).url;
  const consentUrl = new URL(location ?? fail(`authorize did not redirect (${authorize.status})`), BASE);
  if (consentUrl.searchParams.get("error")) fail(`authorize refused: ${consentUrl.search}`);

  const consent = await json<{ url: string }>(
    await fetch(`${BASE}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { ...headers, accept: "application/json", cookie },
      body: JSON.stringify({ accept: true, scope, oauth_query: consentUrl.search.slice(1) }),
    }),
    "consent",
  );
  const code = new URL(consent.url).searchParams.get("code") ?? fail("no authorization code");

  const tokens = await json<{ access_token: string; refresh_token?: string }>(
    await fetch(metadata.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: client.client_id,
        code_verifier: verifier,
        resource: resource.resource,
      }).toString(),
    }),
    "token exchange",
  );
  writeCache({ key, clientId: client.client_id, refreshToken: tokens.refresh_token });
  return tokens.access_token;
}

function readArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  const text = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
  return JSON.parse(text) as Record<string, unknown>;
}

async function main() {
  const [command = "tools", name, rawArgs] = process.argv.slice(2);
  const token = await accessToken();
  const client = new Client({ name: "mcp-local", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }),
  );
  try {
    if (command === "tools") {
      const listed = await client.listTools();
      for (const item of listed.tools) {
        const kind = item.annotations?.readOnlyHint ? "read " : item.annotations?.destructiveHint ? "write!" : "write";
        console.log(`${kind.padEnd(7)}${item.name}`);
      }
      return;
    }
    if (command !== "call" || !name) fail("usage: mcp-local tools | mcp-local call <tool> [json | @file.json]");
    const result = await client.callTool({ name, arguments: readArgs(rawArgs) });
    const parts = (result.content as Array<{ type: string; text?: string }>).filter((part) => part.type === "text");
    console.log(parts[0]?.text ?? "");
    if (result.structuredContent) console.log(JSON.stringify(result.structuredContent, null, 2));
    if (result.isError) process.exitCode = 2;
  } finally {
    await client.close();
  }
}

void main();
