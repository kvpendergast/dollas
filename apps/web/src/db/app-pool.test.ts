import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BRIDGE_WARNING, appLoginError, appLoginProblems, appPoolConfig, bridgeWarning, type AppLoginFacts } from "./app-pool";

const SAFE: AppLoginFacts = {
  currentUser: "dollas_app",
  superuser: false,
  bypassrls: false,
  createrole: false,
  createdb: false,
  neonSuperuser: false,
  privilegedMember: false,
  ownsHousehold: false,
  forceRls: false,
  rlsEnabled: true,
};

const OWNER = "postgresql://neondb_owner:secret@ep-x-pooler.us-east-2.aws.neon.tech/neondb";
const APP = "postgresql://dollas_app:secret@ep-x-pooler.us-east-2.aws.neon.tech/neondb";

describe("app pool URL", () => {
  it("uses DATABASE_URL_APP without the bridge when it is set", () => {
    assert.deepEqual(appPoolConfig({ DATABASE_URL_APP: APP, DATABASE_URL: OWNER }), { mode: "login", url: APP });
    assert.deepEqual(appPoolConfig({ DATABASE_URL_APP: `  ${APP}  `, DATABASE_URL: OWNER }), { mode: "login", url: APP });
  });

  it("falls back to DATABASE_URL with the SET LOCAL ROLE bridge", () => {
    assert.deepEqual(appPoolConfig({ DATABASE_URL: OWNER }), { mode: "bridge", url: OWNER });
    assert.deepEqual(appPoolConfig({ DATABASE_URL_APP: " ", DATABASE_URL: OWNER }), { mode: "bridge", url: OWNER });
  });

  it("never uses the unpooled migration URL for app traffic", () => {
    assert.throws(() => appPoolConfig({ DATABASE_URL_UNPOOLED: OWNER, DATABASE_MIGRATE_URL: OWNER }), /DATABASE_URL_APP or DATABASE_URL is required/);
  });

  it("warns only when the bridge runs on a login that is not dollas_app", () => {
    assert.equal(bridgeWarning({ mode: "login", url: APP }), null);
    assert.equal(bridgeWarning({ mode: "bridge", url: OWNER }), BRIDGE_WARNING);
    assert.equal(bridgeWarning({ mode: "bridge", url: "postgresql://dollas_app:dollas@127.0.0.1:5432/dollas" }), null);
    assert.equal(bridgeWarning({ mode: "bridge", url: "not a url" }), BRIDGE_WARNING);
    assert.doesNotMatch(BRIDGE_WARNING, /postgres(ql)?:\/\//);
  });
});

describe("dollas_app login check", () => {
  it("accepts dollas_app with no privileged attributes", () => {
    assert.deepEqual(appLoginProblems(SAFE), []);
  });

  it("refuses anything that could bypass row-level security", () => {
    const cases: Array<[Partial<AppLoginFacts>, RegExp]> = [
      [{ currentUser: "neondb_owner" }, /logs in as neondb_owner/],
      [{ superuser: true }, /superuser/],
      [{ bypassrls: true }, /BYPASSRLS/],
      [{ neonSuperuser: true }, /neon_superuser/],
      [{ privilegedMember: true }, /member of a superuser or BYPASSRLS role/],
      [{ createrole: true }, /CREATEROLE/],
      [{ createdb: true }, /CREATEDB/],
      [{ rlsEnabled: false }, /row-level security is off/],
      [{ rlsEnabled: null }, /cannot see the household table/],
      [{ ownsHousehold: true }, /owns the household table/],
    ];
    for (const [change, pattern] of cases) {
      const problems = appLoginProblems({ ...SAFE, ...change });
      assert.equal(problems.length, 1, JSON.stringify(change));
      assert.match(problems[0] ?? "", pattern);
    }
    assert.deepEqual(appLoginProblems({ ...SAFE, ownsHousehold: true, forceRls: true }), []);
  });

  it("explains the refusal without a connection string", () => {
    const message = appLoginError(appLoginProblems({ ...SAFE, superuser: true, neonSuperuser: true })).message;
    assert.match(message, /Refusing to serve: it is a superuser; is a member of neon_superuser/);
    assert.match(message, /infra\/README\.md/);
    assert.doesNotMatch(message, /postgres(ql)?:\/\//);
  });
});
