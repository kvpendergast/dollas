import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import postgres from "postgres";
import { migrateWithUrl } from "./apply-migrations";

/**
 * Security review: household isolation must not depend on every query
 * remembering a predicate. This walks the live catalog, so a new table with a
 * household_id column that forgets row-level security (or a policy that does
 * not use app_can_access_household) fails CI.
 */
const OWNER_URL = "postgresql://dollas:dollas@127.0.0.1:5432/dollas";
const APP_URL = "postgresql://dollas_app:dollas@127.0.0.1:5432/dollas";

/** Tables with no household_id, and why that is fine. Anything else needs a household policy. */
const NOT_HOUSEHOLD_SCOPED: Record<string, string> = {
  user: "identity, read by Better Auth",
  session: "browser sessions, Better Auth",
  account: "sign-in methods, Better Auth",
  verification: "email and reset tokens, Better Auth",
  oauth_client: "OAuth plugin tables are keyed by member; every query filters by user and household (agents/connections.ts)",
  oauth_resource: "OAuth plugin",
  oauth_client_resource: "OAuth plugin",
  oauth_refresh_token: "OAuth plugin, tokens hashed",
  oauth_access_token: "OAuth plugin, tokens hashed",
  oauth_consent: "OAuth plugin",
  oauth_client_assertion: "OAuth plugin",
  rate_limit: "hashed rate limit counters, no tenant data",
  household: "the household row itself; its own policies check app_can_access_household(id)",
};

describe("row-level security coverage", () => {
  it("every household table has RLS on and policies built on app_can_access_household; another member sees and changes nothing", async (t) => {
    const owner = postgres(OWNER_URL, { max: 1, prepare: false, connect_timeout: 5, onnotice() {} });
    try {
      await owner`select 1`;
    } catch (error) {
      await owner.end({ timeout: 1 }).catch(() => undefined);
      if (process.env.CI) throw error;
      t.skip("Postgres is not running on 127.0.0.1:5432");
      return;
    }
    await migrateWithUrl(OWNER_URL, { env: { DATABASE_URL: APP_URL } });
    const app = postgres(APP_URL, { max: 1, prepare: false, connect_timeout: 5, onnotice() {} });
    const userA = randomUUID();
    const userB = randomUUID();
    let houseA = "";
    let houseB = "";
    let failure: unknown;
    try {
      const tables = await owner<{ name: string; rls: boolean; household: boolean }[]>`
        select c.relname as name, c.relrowsecurity as rls,
          exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'household_id' and not a.attisdropped) as household
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relname not like '\\_\\_drizzle%' and c.relname <> 'drizzle_migrations'
        order by 1`;
      const scoped = tables.filter((table) => table.household);
      assert.ok(scoped.length >= 15, "the catalog walk found the household tables");
      for (const table of tables.filter((row) => !row.household)) {
        assert.ok(
          NOT_HOUSEHOLD_SCOPED[table.name],
          `${table.name} has no household_id column. Add household RLS to it, or list it in NOT_HOUSEHOLD_SCOPED with the reason.`,
        );
      }
      for (const table of scoped) {
        assert.equal(table.rls, true, `${table.name} must ENABLE ROW LEVEL SECURITY`);
        const policies = await owner<{ name: string; using: string | null; check: string | null; roles: string[] }[]>`
          select p.polname as name, pg_get_expr(p.polqual, p.polrelid) as using, pg_get_expr(p.polwithcheck, p.polrelid) as check,
            array(select rolname from pg_roles where oid = any(p.polroles)) as roles
          from pg_policy p where p.polrelid = ${`public.${table.name}`}::regclass`;
        assert.ok(policies.length > 0, `${table.name} has no policy, so the app role sees nothing (or something is wrong)`);
        for (const policy of policies) {
          assert.match(policy.using ?? "", /app_can_access_household/, `${table.name}.${policy.name} must test household membership`);
          if (policy.check !== null) assert.match(policy.check, /app_can_access_household/, `${table.name}.${policy.name} WITH CHECK must test household membership`);
        }
        const permissive = await owner`select 1 from pg_policy where polrelid = ${`public.${table.name}`}::regclass and polpermissive and polqual is null`;
        assert.equal(permissive.length, 0, `${table.name} has an unconditional policy`);
      }

      // Behavior: Ada's household is invisible and immutable to Bea, table by table.
      await owner`insert into "user" (id, name, email, email_verified) values (${userA}, 'Ada', ${`ada-${userA}@rls.test`}, true), (${userB}, 'Bea', ${`bea-${userB}@rls.test`}, true)`;
      houseA = (await owner<{ id: string }[]>`insert into household (name, created_by) values ('RLS A', ${userA}) returning id`)[0]?.id ?? "";
      houseB = (await owner<{ id: string }[]>`insert into household (name, created_by) values ('RLS B', ${userB}) returning id`)[0]?.id ?? "";
      await owner`insert into household_member (household_id, user_id, role) values (${houseA}, ${userA}, 'owner'), (${houseB}, ${userB}, 'owner')`;
      await owner`insert into category_group (household_id, name) values (${houseA}, 'Ada group')`;
      await owner`insert into ledger_account (household_id, name, type) values (${houseA}, 'Ada checking', 'checking')`;

      const canDelete = new Set(
        (await owner<{ name: string }[]>`select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege('dollas_app', c.oid, 'delete')`).map((row) => row.name),
      );
      await app.begin(async (tx) => {
        await tx`select set_config('app.user_id', ${userB}, true)`;
        for (const table of scoped.map((row) => row.name).concat("household")) {
          const idColumn = table === "household" ? "id" : "household_id";
          const seen = await tx.unsafe(`select count(*)::int as n from "${table}" where ${idColumn} = $1`, [houseA]);
          assert.equal(seen[0]?.n, 0, `${table}: Bea can read Ada's rows`);
          if (table !== "household" && canDelete.has(table)) {
            const deleted = await tx.unsafe(`delete from "${table}" where household_id = $1 returning 1`, [houseA]);
            assert.equal(deleted.length, 0, `${table}: Bea can delete Ada's rows`);
          }
        }
        const changed = await tx`update ledger_account set name = 'Bea was here' where household_id = ${houseA} returning id`;
        assert.equal(changed.length, 0, "update reaches nothing");
        await assert.rejects(
          () => tx`savepoint s`.then(() => tx`insert into category_group (household_id, name) values (${houseA}, 'planted')`),
          /row-level security/,
          "insert into another household is refused by WITH CHECK",
        );
      }).catch((error: unknown) => {
        // The rejected insert aborts the transaction; that is the expected end.
        if (!(error instanceof Error) || !/row-level security|current transaction is aborted/.test(error.message)) throw error;
      });

      const intact = await owner`select name from ledger_account where household_id = ${houseA}`;
      assert.deepEqual(intact.map((row) => row.name), ["Ada checking"]);
      const groups = await owner`select name from category_group where household_id = ${houseA}`;
      assert.deepEqual(groups.map((row) => row.name), ["Ada group"]);
    } catch (error) {
      failure = error;
    } finally {
      await owner`delete from household where id in (${houseA || randomUUID()}, ${houseB || randomUUID()})`.catch(() => undefined);
      await owner`delete from "user" where id in (${userA}, ${userB})`.catch(() => undefined);
      await app.end({ timeout: 5 });
      await owner.end({ timeout: 5 });
    }
    if (failure) throw failure;
  });
});
