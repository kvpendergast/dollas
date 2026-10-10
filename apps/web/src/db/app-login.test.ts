import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { eq, sql as drizzleSql } from "drizzle-orm";
import postgres from "postgres";
import { withActor } from "./actor";
import { assertAppLogin, appPoolConfig } from "./app-pool";
import { checkAppPool, migrateWithUrl } from "./apply-migrations";
import { openAppDatabase } from "./client";
import { household, transaction } from "./schema";

const OWNER_URL = "postgresql://dollas:dollas@127.0.0.1:5432/dollas";
const APP_URL = "postgresql://dollas_app:dollas@127.0.0.1:5432/dollas";
const PROBE_OWNER = "pen214_neon_like_owner";
const INFRA_SQL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../infra/sql/dollas-app-login.sql");

function idsOf(rows: Array<{ id: string }>): string[] {
  return rows.map((row) => row.id).sort();
}

describe("dollas_app LOGIN role (PEN-214)", () => {
  it("is created by the infra SQL, passes the startup check, and cannot read another household", async (t) => {
    const owner = postgres(OWNER_URL, { max: 1, prepare: false, connect_timeout: 5, onnotice() {} });
    try {
      await owner`select 1`;
    } catch (error) {
      await owner.end({ timeout: 1 }).catch(() => undefined);
      if (process.env.CI) throw error;
      t.skip("Postgres is not running on 127.0.0.1:5432");
      return;
    }

    const userA = crypto.randomUUID();
    const userB = crypto.randomUUID();
    let houseA = "";
    let houseB = "";
    let closeApp: (() => Promise<void>) | undefined;
    const savedVercel = process.env.VERCEL;
    try {
      // The infra SQL runs as a Neon-like owner: CREATEROLE and CREATEDB, not a superuser.
      // The password stays what the other test files use ('dollas'); reusing the stored
      // SCRAM verifier keeps them unaffected while this file runs in parallel.
      const [existing] = await owner<{ verifier: string | null }[]>`
        select rolpassword as verifier from pg_authid where rolname = 'dollas_app'
      `;
      const [probe] = await owner<{ n: string }[]>`select count(*)::text as n from pg_roles where rolname = ${PROBE_OWNER}`;
      if (probe?.n === "0") await owner.unsafe(`CREATE ROLE ${PROBE_OWNER} NOLOGIN CREATEROLE CREATEDB`);
      if (existing) await owner.unsafe(`GRANT dollas_app TO ${PROBE_OWNER} WITH ADMIN OPTION`);
      const literal = existing?.verifier ?? "dollas";
      assert.doesNotMatch(literal, /'/);
      const script = readFileSync(INFRA_SQL, "utf8").replace(":'app_password'", `'${literal}'`);
      const applyInfraSql = () =>
        owner.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL ROLE ${PROBE_OWNER}`);
          await tx.unsafe(script).simple();
        });
      try {
        await applyInfraSql();
      } catch (error) {
        // CI starts without dollas_app; another test file may create it at the same moment.
        const code = (error as { code?: string }).code;
        if (code !== "42710" && code !== "23505") throw error;
        await owner.unsafe(`GRANT dollas_app TO ${PROBE_OWNER} WITH ADMIN OPTION`);
        await applyInfraSql();
      }

      const [role] = await owner<
        { login: boolean; superuser: boolean; bypassrls: boolean; createrole: boolean; createdb: boolean }[]
      >`
        select rolcanlogin as login, rolsuper as superuser, rolbypassrls as bypassrls,
          rolcreaterole as createrole, rolcreatedb as createdb
        from pg_roles where rolname = 'dollas_app'
      `;
      assert.deepEqual({ ...role }, { login: true, superuser: false, bypassrls: false, createrole: false, createdb: false });

      // Startup on Vercel used to force NOLOGIN. It must leave the infra login alone now.
      process.env.VERCEL = "1";
      await migrateWithUrl(OWNER_URL, { env: { DATABASE_URL: OWNER_URL } });
      if (savedVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = savedVercel;
      const [after] = await owner<{ login: boolean }[]>`select rolcanlogin as login from pg_roles where rolname = 'dollas_app'`;
      assert.equal(after?.login, true, "startup migrations must not remove LOGIN from dollas_app");

      // Fail-closed startup check: the dollas_app login passes, the owner does not.
      await assertAppLogin(APP_URL);
      await checkAppPool({ DATABASE_URL_APP: APP_URL, DATABASE_URL: OWNER_URL }, OWNER_URL);
      await assert.rejects(() => assertAppLogin(OWNER_URL), (error: Error) => {
        assert.match(error.message, /logs in as dollas, not dollas_app; is a superuser/);
        assert.doesNotMatch(error.message, /postgres(ql)?:\/\//);
        return true;
      });
      await assert.rejects(
        () => assertAppLogin("postgresql://dollas_app:wrong-password@127.0.0.1:5432/dollas"),
        /Could not log in with DATABASE_URL_APP to confirm it is dollas_app \(28P01\)/,
      );

      await owner`
        insert into "user" (id, name, email, email_verified)
        values (${userA}, 'Login Ada', ${`${userA}@example.test`}, true), (${userB}, 'Login Bea', ${`${userB}@example.test`}, true)
      `;
      const houses = await owner<{ id: string; name: string }[]>`
        insert into household (name, created_by) values ('Login House A', ${userA}), ('Login House B', ${userB})
        returning id, name
      `;
      houseA = houses.find((row) => row.name === "Login House A")?.id ?? "";
      houseB = houses.find((row) => row.name === "Login House B")?.id ?? "";
      await owner`
        insert into household_member (household_id, user_id, role)
        values (${houseA}, ${userA}, 'owner'), (${houseB}, ${userB}, 'owner')
      `;
      const ledger = async (householdId: string, payee: string) => {
        const [account] = await owner<{ id: string }[]>`
          insert into ledger_account (household_id, name, type) values (${householdId}, 'Checking', 'checking') returning id
        `;
        const [category] = await owner<{ id: string }[]>`
          insert into category (household_id, name, kind) values (${householdId}, 'Rent', 'expense') returning id
        `;
        return owner.begin(async (tx) => {
          const [row] = await tx<{ id: string }[]>`
            insert into transaction (household_id, account_id, occurred_on, payee, amount_cents)
            values (${householdId}, ${account.id}, '2026-10-01', ${payee}, -100) returning id
          `;
          await tx`
            insert into transaction_split (transaction_id, household_id, category_id, amount_cents)
            values (${row.id}, ${householdId}, ${category.id}, -100)
          `;
          return row.id;
        });
      };
      const transactionA = await ledger(houseA, "Login Rent A");
      const transactionB = await ledger(houseB, "Login Rent B");

      // The pool the app opens when DATABASE_URL_APP is set: no SET LOCAL ROLE bridge.
      const pool = appPoolConfig({ DATABASE_URL_APP: APP_URL, DATABASE_URL: OWNER_URL });
      assert.equal(pool.mode, "login");
      const app = openAppDatabase(pool.url, 1, { bridge: false });
      closeApp = () => app.close();

      const [who] = await app.db.execute<{ current_user: string; session_user: string }>(
        drizzleSql`select current_user, session_user`,
      );
      assert.deepEqual({ ...who }, { current_user: "dollas_app", session_user: "dollas_app" });

      const anonymous = await app.db.select({ id: household.id }).from(household);
      assert.deepEqual(anonymous, [], "no member set, no households");

      const adaHouses = await withActor(userA, (tx) => tx.select({ id: household.id }).from(household), app.db);
      const adaTransactions = await withActor(userA, (tx) => tx.select({ id: transaction.id }).from(transaction), app.db);
      const beaTransactions = await withActor(userB, (tx) => tx.select({ id: transaction.id }).from(transaction), app.db);
      assert.deepEqual(idsOf(adaHouses), [houseA]);
      assert.deepEqual(idsOf(adaTransactions), [transactionA]);
      assert.deepEqual(idsOf(beaTransactions), [transactionB]);

      const hijack = await withActor(
        userA,
        (tx) => tx.update(transaction).set({ payee: "Hijacked" }).where(eq(transaction.id, transactionB)).returning({ id: transaction.id }),
        app.db,
      );
      assert.deepEqual(hijack, []);
      const [untouched] = await owner<{ payee: string }[]>`select payee from transaction where id = ${transactionB}`;
      assert.equal(untouched?.payee, "Login Rent B");

      // Even an explicit attempt to become the owner is refused for this login.
      await assert.rejects(
        () => app.db.execute(drizzleSql`set role dollas`),
        (error: Error) => /permission denied/.test(String((error.cause as Error | undefined)?.message ?? error.message)),
      );
    } finally {
      if (savedVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = savedVercel;
      if (closeApp) await closeApp();
      if (houseA || houseB) await owner`delete from household where id in (${houseA || houseB}, ${houseB || houseA})`.catch(() => undefined);
      await owner`delete from "user" where id in (${userA}, ${userB})`.catch(() => undefined);
      await owner.end({ timeout: 5 });
    }
  });
});
