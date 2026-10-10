import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import postgres from "postgres";
import { assertAppRoleSubjectToRls, migrateWithUrl } from "../../db/apply-migrations";
import { initTelemetry } from "../../lib/telemetry";

const OWNER_URL = "postgresql://dollas:dollas@127.0.0.1:5432/dollas";
const APP_URL = "postgresql://dollas_app:dollas@127.0.0.1:5432/dollas";
const ORIGIN = "https://agents.test";
const REDIRECT = "http://127.0.0.1:7777/callback";
const MCP = `${ORIGIN}/api/mcp`;
const READ = "dollas:read";
const WRITE = "dollas:write";
const REFRESH = "offline_access";

function base64url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function pkce() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function sha256url(value: string): string {
  return base64url(createHash("sha256").update(value).digest());
}

type Tokens = { access_token: string; refresh_token?: string; scope: string; expires_in: number; token_type: string };

describe("agent OAuth and MCP", () => {
  it("registers, consents per household, issues hashed PKCE tokens, rotates refresh, enforces scope and RLS, and revokes", async (t) => {
    initTelemetry();
    const owner = postgres(OWNER_URL, { max: 1, prepare: false, connect_timeout: 5, onnotice() {} });
    try {
      await owner`select 1`;
    } catch (error) {
      await owner.end({ timeout: 1 }).catch(() => undefined);
      if (process.env.CI) throw error;
      t.skip("Postgres is not running on 127.0.0.1:5432");
      return;
    }

    const appRole = await owner<{ n: string }[]>`select count(*)::text as n from pg_roles where rolname = 'dollas_app'`;
    if (appRole[0]?.n === "0") {
      await owner.unsafe("CREATE ROLE dollas_app LOGIN PASSWORD 'dollas' NOSUPERUSER NOBYPASSRLS");
    }
    await migrateWithUrl(OWNER_URL, { env: { DATABASE_URL: APP_URL } });
    await assertAppRoleSubjectToRls(OWNER_URL);

    // The auth instance and services read these lazily on first use.
    process.env.DATABASE_URL = OWNER_URL;
    process.env.BETTER_AUTH_URL = ORIGIN;
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM;
    const { getAuth } = await import("../../lib/auth");
    const { handleMcpRequest } = await import("./mcp");
    const { revokeAgentConnection, listAgentConnections } = await import("./connections");
    const { authorizationServerMetadataResponse, protectedResourceMetadataResponse } = await import("./metadata");
    const auth = getAuth();

    const stamp = randomBytes(4).toString("hex");
    const people = {
      ada: `ada-${stamp}@agents.test`,
      bob: `bob-${stamp}@agents.test`,
      cy: `cy-${stamp}@agents.test`,
    };
    const password = `pw-${randomBytes(9).toString("hex")}`;
    const ids: Record<keyof typeof people, string> = { ada: "", bob: "", cy: "" };
    const houses: string[] = [];
    const clients: string[] = [];

    const call = (path: string, init: RequestInit & { cookie?: string } = {}) => {
      const headers = new Headers(init.headers);
      headers.set("origin", ORIGIN);
      if (init.cookie) headers.set("cookie", init.cookie);
      return auth.handler(new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: "manual" }));
    };

    async function signIn(email: string): Promise<string> {
      const response = await call("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      const cookies = response.headers.getSetCookie().map((line) => line.split(";")[0]);
      return cookies.join("; ");
    }

    async function register(name: string): Promise<string> {
      const response = await call("/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: name,
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      });
      assert.equal(response.status, 201, await response.clone().text());
      const body = (await response.json()) as { client_id: string; client_secret?: string; application_type?: string };
      assert.equal(body.application_type, "native", "loopback public clients register as native apps");
      assert.equal(body.client_secret, undefined, "public clients get no secret");
      clients.push(body.client_id);
      return body.client_id;
    }

    function authorizeQuery(clientId: string, challenge: string, scope: string, method = "S256") {
      return new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        scope,
        state: "xyz",
        code_challenge: challenge,
        code_challenge_method: method,
        resource: MCP,
      });
    }

    /** authorize -> consent (as the consent page does) -> code. */
    async function connect(cookie: string, clientId: string, granted: string[], requested = [READ, WRITE, REFRESH]) {
      const { verifier, challenge } = pkce();
      const authorize = await call(`/api/auth/oauth2/authorize?${authorizeQuery(clientId, challenge, requested.join(" "))}`, {
        cookie,
      });
      assert.equal(authorize.status, 302, await authorize.clone().text());
      const consentUrl = new URL(authorize.headers.get("location") ?? "", ORIGIN);
      assert.equal(consentUrl.pathname, "/connect-agent");
      const consent = await call("/api/auth/oauth2/consent", {
        method: "POST",
        cookie,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ accept: true, scope: granted.join(" "), oauth_query: consentUrl.search.slice(1) }),
      });
      assert.equal(consent.status, 200, await consent.clone().text());
      const { url } = (await consent.json()) as { url: string };
      const back = new URL(url);
      assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
      assert.equal(back.searchParams.get("state"), "xyz");
      const code = back.searchParams.get("code");
      assert.ok(code);
      return { code, verifier };
    }

    async function token(form: Record<string, string>) {
      return call("/api/auth/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
      });
    }

    async function exchange(clientId: string, code: string, verifier: string): Promise<Tokens> {
      const response = await token({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        resource: MCP,
      });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()) as Tokens;
    }

    let rpcId = 0;
    async function mcp(accessToken: string | null, method: string, params: Record<string, unknown> = {}) {
      const headers = new Headers({
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      });
      if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
      return handleMcpRequest(
        new Request(MCP, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) }),
      );
    }

    async function tool(accessToken: string, name: string, args: Record<string, unknown> = {}) {
      const response = await mcp(accessToken, "tools/call", { name, arguments: args });
      assert.equal(response.status, 200, await response.clone().text());
      const body = (await response.json()) as {
        result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content: Array<{ text: string }> };
        error?: unknown;
      };
      assert.ok(body.result, JSON.stringify(body));
      return body.result;
    }

    let failure: unknown;
    try {
      // People and households: Ada and Bob share Maple; Cy has Birch.
      for (const key of Object.keys(people) as Array<keyof typeof people>) {
        const response = await call("/api/auth/sign-up/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: key, email: people[key], password }),
        });
        assert.equal(response.status, 200, await response.clone().text());
        const [row] = await owner<{ id: string }[]>`
          update "user" set email_verified = true where email = ${people[key]} returning id
        `;
        ids[key] = row?.id ?? "";
      }
      const created = await owner<{ id: string; name: string }[]>`
        insert into household (name, created_by) values ('Maple', ${ids.ada}), ('Birch', ${ids.cy}) returning id, name
      `;
      const maple = created.find((row) => row.name === "Maple")?.id ?? "";
      const birch = created.find((row) => row.name === "Birch")?.id ?? "";
      houses.push(maple, birch);
      await owner`
        insert into household_member (household_id, user_id, role) values
          (${maple}, ${ids.ada}, 'owner'), (${maple}, ${ids.bob}, 'member'), (${birch}, ${ids.cy}, 'owner')
      `;
      await owner`
        insert into ledger_account (household_id, name, type, opening_balance_cents) values
          (${maple}, 'Maple Checking', 'checking', 125000), (${birch}, 'Birch Secret Savings', 'savings', 999900)
      `;

      // Metadata endpoints.
      const prm = (await protectedResourceMetadataResponse().json()) as Record<string, unknown>;
      assert.equal(prm.resource, MCP);
      assert.deepEqual(prm.authorization_servers, [`${ORIGIN}/api/auth`]);
      assert.deepEqual(prm.scopes_supported, [READ, WRITE, REFRESH]);
      const asResponse = await authorizationServerMetadataResponse(
        new Request(`${ORIGIN}/.well-known/oauth-authorization-server/api/auth`),
      );
      assert.equal(asResponse.status, 200);
      const asm = (await asResponse.json()) as Record<string, unknown>;
      assert.equal(asm.issuer, `${ORIGIN}/api/auth`);
      assert.deepEqual(asm.code_challenge_methods_supported, ["S256"]);
      assert.equal(asm.registration_endpoint, `${ORIGIN}/api/auth/oauth2/register`);
      assert.equal(asm.token_endpoint, `${ORIGIN}/api/auth/oauth2/token`);
      assert.equal(asm.authorization_endpoint, `${ORIGIN}/api/auth/oauth2/authorize`);
      assert.ok((asm.grant_types_supported as string[]).includes("refresh_token"));

      // No token: 401 with a resource_metadata challenge.
      const anonymous = await mcp(null, "tools/list");
      assert.equal(anonymous.status, 401);
      const challenge = anonymous.headers.get("www-authenticate") ?? "";
      assert.match(challenge, /^Bearer /);
      assert.match(challenge, new RegExp(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`));
      assert.match(challenge, /scope="dollas:read dollas:write offline_access"/);
      const garbage = await mcp("dollas_at_not-a-real-token", "tools/list");
      assert.equal(garbage.status, 401);
      assert.match(garbage.headers.get("www-authenticate") ?? "", /error="invalid_token"/);

      const adaCookie = await signIn(people.ada);
      const agent = await register("Claude Test");

      // PKCE: plain is refused, and a wrong verifier cannot redeem the code.
      const plain = await call(`/api/auth/oauth2/authorize?${authorizeQuery(agent, "x".repeat(43), READ, "plain")}`, {
        cookie: adaCookie,
      });
      assert.equal(plain.status, 302);
      assert.match(plain.headers.get("location") ?? "", /error=invalid_request/);
      assert.match(decodeURIComponent(plain.headers.get("location") ?? ""), /S256/);
      const noPkce = await call(
        `/api/auth/oauth2/authorize?${new URLSearchParams({ response_type: "code", client_id: agent, redirect_uri: REDIRECT, scope: READ, state: "s" })}`,
        { cookie: adaCookie },
      );
      assert.match(noPkce.headers.get("location") ?? "", /error=invalid_request/);
      const wrong = await connect(adaCookie, agent, [READ, REFRESH]);
      const badVerifier = await token({
        grant_type: "authorization_code",
        code: wrong.code,
        redirect_uri: REDIRECT,
        client_id: agent,
        code_verifier: pkce().verifier,
      });
      assert.ok([400, 401].includes(badVerifier.status), String(badVerifier.status));
      const badBody = (await badVerifier.json()) as { error?: string; error_description?: string };
      assert.match(badBody.error_description ?? "", /code verification failed/, JSON.stringify(badBody));
      // The code was burned by the failed attempt or still needs the right verifier; either way, start fresh.

      // Read-only connection for Ada.
      const readGrant = await connect(adaCookie, agent, [READ, REFRESH]);
      const readTokens = await exchange(agent, readGrant.code, readGrant.verifier);
      assert.equal(readTokens.token_type.toLowerCase(), "bearer");
      assert.ok(readTokens.expires_in <= 15 * 60);
      assert.match(readTokens.access_token, /^dollas_at_/);
      assert.match(readTokens.refresh_token ?? "", /^dollas_rt_/);
      assert.deepEqual(readTokens.scope.split(" ").sort(), [READ, REFRESH].sort());
      // Tokens are stored hashed, bound to member and household.
      const rawAccess = readTokens.access_token.slice("dollas_at_".length);
      const stored = await owner<{ token: string; user_id: string; reference_id: string; expires_at: Date }[]>`
        select token, user_id, reference_id, expires_at from oauth_access_token where token = ${sha256url(rawAccess)}
      `;
      assert.equal(stored.length, 1);
      assert.equal(stored[0]?.user_id, ids.ada);
      assert.equal(stored[0]?.reference_id, maple);
      assert.ok((stored[0]?.expires_at.getTime() ?? 0) - Date.now() <= 15 * 60 * 1000 + 5000);
      const plainRows = await owner<{ n: string }[]>`
        select count(*)::text as n from oauth_access_token where token in (${readTokens.access_token}, ${rawAccess})
      `;
      assert.equal(plainRows[0]?.n, "0");
      const plainRefresh = await owner<{ n: string }[]>`
        select count(*)::text as n from oauth_refresh_token where token in (${readTokens.refresh_token ?? ""}, ${(readTokens.refresh_token ?? "").slice("dollas_rt_".length)})
      `;
      assert.equal(plainRefresh[0]?.n, "0");

      const replayCode = await token({
        grant_type: "authorization_code",
        code: readGrant.code,
        redirect_uri: REDIRECT,
        client_id: agent,
        code_verifier: readGrant.verifier,
      });
      assert.equal(replayCode.status, 400, "an authorization code works once");
      // Replaying a code also revokes what that code issued (RFC 6749 4.1.2).
      assert.equal((await mcp(readTokens.access_token, "tools/list")).status, 401);
      const again = await connect(adaCookie, agent, [READ, REFRESH]);
      Object.assign(readTokens, await exchange(agent, again.code, again.verifier));

      // Read tools work and only see Maple (RLS through the same services).
      const tools = await mcp(readTokens.access_token, "tools/list");
      assert.equal(tools.status, 200);
      const listed = (await tools.json()) as { result: { tools: Array<{ name: string }> } };
      assert.deepEqual(listed.result.tools.map((item) => item.name).sort(), ["add_account", "list_accounts", "whoami"]);
      const who = await tool(readTokens.access_token, "whoami");
      assert.deepEqual(who.structuredContent?.household, { name: "Maple", currency: "USD", timezone: "UTC" });
      assert.equal(who.structuredContent?.access, "read");
      const accounts = await tool(readTokens.access_token, "list_accounts");
      const names = (accounts.structuredContent?.items as Array<{ name: string; balanceCents: number }>).map((a) => a.name);
      assert.deepEqual(names, ["Maple Checking"]);
      assert.equal(JSON.stringify(accounts).includes("Birch"), false);

      // A read token cannot write: 403 step-up at HTTP, and nothing is added.
      const denied = await mcp(readTokens.access_token, "tools/call", {
        name: "add_account",
        arguments: { name: "Sneaky", type: "cash" },
      });
      assert.equal(denied.status, 403);
      const step = denied.headers.get("www-authenticate") ?? "";
      assert.match(step, /error="insufficient_scope"/);
      assert.match(step, /scope="dollas:read dollas:write offline_access"/);
      const sneaky = await owner`select 1 from ledger_account where name = 'Sneaky'`;
      assert.equal(sneaky.length, 0);

      // Last used is recorded and Settings lists the connection.
      const listedConnections = await listAgentConnections({ userId: ids.ada, householdId: maple });
      assert.ok(listedConnections.ok);
      assert.equal(listedConnections.value.length, 1);
      assert.equal(listedConnections.value[0]?.clientName, "Claude Test");
      assert.equal(listedConnections.value[0]?.access, "Read only");
      assert.ok(listedConnections.value[0]?.lastUsedAt instanceof Date);
      assert.ok(listedConnections.value[0]?.connectedAt instanceof Date);
      // Bob shares the household but does not see Ada's agents.
      const bobView = await listAgentConnections({ userId: ids.bob, householdId: maple });
      assert.ok(bobView.ok);
      assert.equal(bobView.value.length, 0);

      // Refresh rotates; reusing the old refresh token kills the whole family.
      const rotated = await token({ grant_type: "refresh_token", refresh_token: readTokens.refresh_token ?? "", client_id: agent });
      assert.equal(rotated.status, 200, await rotated.clone().text());
      const next = (await rotated.json()) as Tokens;
      assert.notEqual(next.refresh_token, readTokens.refresh_token);
      assert.notEqual(next.access_token, readTokens.access_token);
      assert.equal((await mcp(next.access_token, "tools/list")).status, 200);
      const reuse = await token({ grant_type: "refresh_token", refresh_token: readTokens.refresh_token ?? "", client_id: agent });
      assert.equal(reuse.status, 400);
      const afterReuse = await token({ grant_type: "refresh_token", refresh_token: next.refresh_token ?? "", client_id: agent });
      assert.equal(afterReuse.status, 400, "replay revokes the rotated refresh token too");

      // Expired access tokens stop working.
      const fresh = await connect(adaCookie, agent, [READ, REFRESH]);
      const freshTokens = await exchange(agent, fresh.code, fresh.verifier);
      assert.equal((await mcp(freshTokens.access_token, "tools/list")).status, 200);
      await owner`
        update oauth_access_token set expires_at = now() - interval '1 second'
        where token = ${sha256url(freshTokens.access_token.slice("dollas_at_".length))}
      `;
      assert.equal((await mcp(freshTokens.access_token, "tools/list")).status, 401);

      // Read and write: the write tool runs as Ada in Maple.
      const writeGrant = await connect(adaCookie, agent, [READ, WRITE, REFRESH]);
      const writeTokens = await exchange(agent, writeGrant.code, writeGrant.verifier);
      assert.deepEqual(writeTokens.scope.split(" ").sort(), [READ, WRITE, REFRESH].sort());
      const added = await tool(writeTokens.access_token, "add_account", {
        name: "Agent Cash",
        type: "cash",
        opening_balance: "12.34",
      });
      assert.equal(added.isError, undefined, JSON.stringify(added));
      assert.equal(added.structuredContent?.openingBalanceCents, 1234);
      const inMaple = await owner<{ household_id: string }[]>`select household_id from ledger_account where name = 'Agent Cash'`;
      assert.deepEqual(inMaple.map((row) => row.household_id), [maple]);
      const invalid = await tool(writeTokens.access_token, "add_account", { name: "Bad", type: "cash", opening_balance: "abc" });
      assert.equal(invalid.isError, true);

      // Cy's agent sees Birch only, never Maple.
      const cyCookie = await signIn(people.cy);
      const cyGrant = await connect(cyCookie, agent, [READ, REFRESH]);
      const cyTokens = await exchange(agent, cyGrant.code, cyGrant.verifier);
      const cyAccounts = await tool(cyTokens.access_token, "list_accounts");
      const cyNames = (cyAccounts.structuredContent?.items as Array<{ name: string }>).map((a) => a.name);
      assert.deepEqual(cyNames, ["Birch Secret Savings"]);
      // A token whose household claim were swapped still runs as Cy, whom RLS keeps out of Maple.
      await owner`
        update oauth_access_token set reference_id = ${maple}
        where token = ${sha256url(cyTokens.access_token.slice("dollas_at_".length))}
      `;
      assert.equal((await mcp(cyTokens.access_token, "tools/list")).status, 401, "no consent and no membership for Maple");

      // Revoking in Settings kills access and refresh immediately.
      const before = await listAgentConnections({ userId: ids.ada, householdId: maple });
      assert.ok(before.ok);
      const connection = before.value[0];
      assert.ok(connection);
      const revokedForBob = await revokeAgentConnection({ userId: ids.bob, householdId: maple }, connection.id);
      assert.equal(revokedForBob.ok, false, "another member cannot revoke Ada's agent");
      const revoked = await revokeAgentConnection({ userId: ids.ada, householdId: maple }, connection.id);
      assert.ok(revoked.ok);
      assert.ok(revoked.value.revokedTokens >= 2);
      const cut = await mcp(writeTokens.access_token, "tools/list");
      assert.equal(cut.status, 401);
      assert.match(cut.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
      const cutRefresh = await token({ grant_type: "refresh_token", refresh_token: writeTokens.refresh_token ?? "", client_id: agent });
      assert.equal(cutRefresh.status, 400);
      const after = await listAgentConnections({ userId: ids.ada, householdId: maple });
      assert.ok(after.ok);
      assert.equal(after.value.length, 0);

      // Leaving the household disconnects the member's agents for it.
      const bobCookie = await signIn(people.bob);
      const bobGrant = await connect(bobCookie, agent, [READ, REFRESH]);
      const bobTokens = await exchange(agent, bobGrant.code, bobGrant.verifier);
      assert.equal((await mcp(bobTokens.access_token, "tools/list")).status, 200);
      await owner`delete from household_member where household_id = ${maple} and user_id = ${ids.bob}`;
      assert.equal((await mcp(bobTokens.access_token, "tools/list")).status, 401);
      const bobRows = await owner<{ revoked: Date | null }[]>`
        select revoked from oauth_refresh_token where user_id = ${ids.bob}
      `;
      assert.ok(bobRows.length > 0 && bobRows.every((row) => row.revoked !== null));
    } catch (error) {
      failure = error;
    } finally {
      try {
        for (const client of clients) await owner`delete from oauth_client where client_id = ${client}`;
        for (const house of houses) await owner`delete from household where id = ${house}`;
        for (const email of Object.values(people)) await owner`delete from "user" where email = ${email}`;
      } finally {
        await owner.end({ timeout: 5 });
        const { closeDb } = await import("../../db/client");
        await closeDb();
      }
    }
    if (failure) throw failure;
  });
});
