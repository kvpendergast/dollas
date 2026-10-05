import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { encryptToken, parseTokenKeyRing } from "@dollas/domain";
import { withActor } from "./actor";
import { assertAppRoleSubjectToRls, migrateWithUrl } from "./apply-migrations";
import { openAppDatabase } from "./client";
import { bankConnection, household, transaction } from "./schema";

const OWNER_URL = "postgresql://dollas:dollas@127.0.0.1:5432/dollas";
const APP_URL = "postgresql://dollas_app:dollas@127.0.0.1:5432/dollas";

function idsOf(rows: Array<{ id: string }>): string[] {
  return rows.map((row) => row.id).sort();
}

describe("row-level security login", () => {
  it("hides another household when the query has no membership predicate", async (t) => {
    const host = new URL(OWNER_URL).hostname;
    assert.ok(host === "127.0.0.1" || host === "localhost");
    const owner = postgres(OWNER_URL, {
      max: 1,
      prepare: false,
      connect_timeout: 5,
      onnotice() {},
    });
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
    const userUnverified = crypto.randomUUID();
    const userGoogle = crypto.randomUUID();
    const users = [userA, userB, userUnverified, userGoogle];
    let houseA = "";
    let houseB = "";
    let transactionA = "";
    let transactionB = "";
    let restoreOwner: string | null = null;
    let closeApp: (() => Promise<void>) | undefined;
    let direct: postgres.Sql | undefined;
    let failure: unknown;

    try {
      const app = openAppDatabase(OWNER_URL, 1);
      closeApp = () => app.close();
      const appRole = await owner<{ n: string }[]>`
        select count(*)::text as n from pg_roles where rolname = 'dollas_app'
      `;
      if (appRole[0]?.n === "0") {
        await owner.unsafe("CREATE ROLE dollas_app LOGIN PASSWORD 'dollas' NOSUPERUSER NOBYPASSRLS");
      } else {
        await owner.unsafe("ALTER ROLE dollas_app WITH LOGIN PASSWORD 'dollas' NOSUPERUSER NOBYPASSRLS");
      }
      const probeRole = await owner<{ n: string }[]>`
        select count(*)::text as n from pg_roles where rolname = 'rls_table_owner'
      `;
      if (probeRole[0]?.n === "0") {
        await owner.unsafe("CREATE ROLE rls_table_owner NOLOGIN NOSUPERUSER NOBYPASSRLS");
      }
      await migrateWithUrl(OWNER_URL, {
        env: { DATABASE_URL: APP_URL },
      });
      await assertAppRoleSubjectToRls(OWNER_URL);

      await owner`
        insert into "user" (id, name, email, email_verified)
        values
          (${userA}, 'RLS Ada', ${`${userA}@example.test`}, true),
          (${userB}, 'RLS Bea', ${`${userB}@example.test`}, true),
          (${userUnverified}, 'RLS Una', ${`${userUnverified}@example.test`}, false),
          (${userGoogle}, 'RLS Gia', ${`${userGoogle}@example.test`}, false)
      `;
      await owner`
        insert into account (id, account_id, provider_id, user_id)
        values (${crypto.randomUUID()}, ${userGoogle}, 'google', ${userGoogle})
      `;
      const houses = await owner<{ id: string; name: string }[]>`
        insert into household (name, created_by)
        values ('RLS House A', ${userA}), ('RLS House B', ${userB})
        returning id, name
      `;
      houseA = houses.find((row) => row.name === "RLS House A")?.id ?? "";
      houseB = houses.find((row) => row.name === "RLS House B")?.id ?? "";
      assert.ok(houseA && houseB);
      await owner`
        insert into household_member (household_id, user_id, role)
        values
          (${houseA}, ${userA}, 'owner'),
          (${houseB}, ${userB}, 'owner'),
          (${houseA}, ${userUnverified}, 'member'),
          (${houseB}, ${userGoogle}, 'member')
      `;

      const ledger = async (householdId: string, payee: string) => {
        const [account] = await owner<{ id: string }[]>`
          insert into ledger_account (household_id, name, type)
          values (${householdId}, 'Checking', 'checking')
          returning id
        `;
        const [category] = await owner<{ id: string }[]>`
          insert into category (household_id, name, kind)
          values (${householdId}, 'Rent', 'expense')
          returning id
        `;
        const [created] = await owner.begin(async (tx) => {
          const [row] = await tx<{ id: string }[]>`
            insert into transaction (household_id, account_id, occurred_on, payee, amount_cents)
            values (${householdId}, ${account.id}, '2026-01-02', ${payee}, -100)
            returning id
          `;
          await tx`
            insert into transaction_split (transaction_id, household_id, category_id, amount_cents)
            values (${row.id}, ${householdId}, ${category.id}, -100)
          `;
          return [row];
        });
        return created.id;
      };
      transactionA = await ledger(houseA, "Rent A");
      transactionB = await ledger(houseB, "Rent B");

      const keyRing = parseTokenKeyRing(`1:${Buffer.from(new Uint8Array(32).fill(3)).toString("base64")}`);
      if (keyRing.isErr()) throw keyRing.error;
      const tokenA = await encryptToken("household-a-access-token", keyRing.value, { householdId: houseA });
      const tokenB = await encryptToken("household-b-access-token", keyRing.value, { householdId: houseB });
      if (tokenA.isErr()) throw tokenA.error;
      if (tokenB.isErr()) throw tokenB.error;
      await owner`
        insert into bank_connection (household_id, provider_id, label, encrypted_access_token, key_version)
        values
          (${houseA}, 'fake', 'House A bank', ${tokenA.value.ciphertext}, ${tokenA.value.keyVersion}),
          (${houseB}, 'fake', 'House B bank', ${tokenB.value.ciphertext}, ${tokenB.value.keyVersion})
      `;

      const visibleHouses = await withActor(
        userA,
        (tx) => tx.select({ id: household.id }).from(household),
        app.db,
      );
      const visibleTransactions = await withActor(
        userB,
        (tx) => tx.select({ id: transaction.id }).from(transaction),
        app.db,
      );
      const adaTransactions = await withActor(
        userA,
        (tx) => tx.select({ id: transaction.id }).from(transaction),
        app.db,
      );
      assert.deepEqual(idsOf(visibleHouses), [houseA]);
      assert.deepEqual(idsOf(adaTransactions), [transactionA]);
      assert.deepEqual(idsOf(visibleTransactions), [transactionB]);

      const adaConnections = await withActor(
        userA,
        (tx) =>
          tx
            .select({
              id: bankConnection.id,
              householdId: bankConnection.householdId,
              token: bankConnection.encryptedAccessToken,
            })
            .from(bankConnection),
        app.db,
      );
      assert.equal(adaConnections.length, 1);
      assert.equal(adaConnections[0]?.householdId, houseA);
      assert.equal(adaConnections[0]?.token, tokenA.value.ciphertext);
      assert.equal(
        adaConnections.some((row) => row.token === tokenB.value.ciphertext),
        false,
      );
      await assert.rejects(() =>
        withActor(
          userA,
          (tx) =>
            tx.insert(bankConnection).values({
              householdId: houseB,
              providerId: "fake",
              label: "Stolen",
              encryptedAccessToken: tokenA.value.ciphertext,
              keyVersion: tokenA.value.keyVersion,
            }),
          app.db,
        ),
      );
      const hiddenDelete = await withActor(
        userA,
        (tx) => tx.delete(bankConnection).where(eq(bankConnection.householdId, houseB)).returning({ id: bankConnection.id }),
        app.db,
      );
      assert.deepEqual(hiddenDelete, []);
      const [stillB] = await owner<{ n: string }[]>`
        select count(*)::text as n from bank_connection where household_id = ${houseB}
      `;
      assert.equal(stillB?.n, "1");
      const connectionA = adaConnections[0]?.id ?? "";
      const removed = await withActor(
        userA,
        (tx) => tx.delete(bankConnection).where(eq(bankConnection.id, connectionA)).returning({ id: bankConnection.id }),
        app.db,
      );
      assert.deepEqual(removed.map((row) => row.id), [connectionA]);
      const [goneA] = await owner<{ n: string }[]>`
        select count(*)::text as n from bank_connection where household_id = ${houseA}
      `;
      assert.equal(goneA?.n, "0");
      const forgottenSession = await app.db.select({ id: household.id }).from(household);
      assert.equal(
        forgottenSession.some((row) => row.id === houseA || row.id === houseB),
        false,
      );
      const forgottenConnections = await app.db
        .select({ householdId: bankConnection.householdId })
        .from(bankConnection);
      assert.equal(
        forgottenConnections.some((row) => row.householdId === houseA || row.householdId === houseB),
        false,
      );

      const [ownerName] = await owner<{ name: string }[]>`
        select pg_get_userbyid(c.relowner) as name
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'household'
      `;
      restoreOwner = ownerName.name === "rls_table_owner" ? "dollas" : ownerName.name;
      const [ownerChange] = await owner<{ stmt: string }[]>`
        select format('ALTER TABLE household OWNER TO %I', 'rls_table_owner') as stmt
      `;
      await owner.unsafe(ownerChange.stmt);
      const bypass = await owner.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE rls_table_owner");
        const [who] = await tx<{ current: string; superuser: boolean }[]>`
          select current_user as current, rolsuper as superuser
          from pg_roles
          where rolname = current_user
        `;
        const rows = await tx<{ id: string }[]>`select id from household where id in (${houseA}, ${houseB})`;
        return { who, rows };
      });
      assert.equal(bypass.who.current, "rls_table_owner");
      assert.equal(bypass.who.superuser, false);
      assert.deepEqual(idsOf(bypass.rows), [houseA, houseB].sort());

      direct = postgres(APP_URL, { max: 1, prepare: false, onnotice() {} });
      const asLogin = async (userId: string) =>
        direct!.begin(async (tx) => {
          await tx`select set_config('app.user_id', ${userId}, true)`;
          return tx<{ id: string }[]>`select id from household`;
        });
      assert.deepEqual(idsOf(await asLogin(userA)), [houseA]);
      assert.deepEqual(idsOf(await asLogin(userUnverified)), []);
      assert.deepEqual(idsOf(await asLogin(userGoogle)), [houseB]);
      const anonymous = await direct<{ id: string }[]>`select id from household`;
      assert.deepEqual(idsOf(anonymous.filter((row) => row.id === houseA || row.id === houseB)), []);
      const asLoginConnections = async (userId: string) =>
        direct!.begin(async (tx) => {
          await tx`select set_config('app.user_id', ${userId}, true)`;
          return tx<{ household_id: string }[]>`select household_id from bank_connection`;
        });
      assert.deepEqual(
        (await asLoginConnections(userB)).map((row) => row.household_id),
        [houseB],
      );
      assert.deepEqual(
        (await asLoginConnections(userA)).map((row) => row.household_id),
        [],
      );

      const scoped = await withActor(
        userA,
        (tx) => tx.select({ id: household.id }).from(household).where(eq(household.id, houseB)),
        app.db,
      );
      assert.deepEqual(scoped, []);
    } catch (error) {
      failure = error;
    } finally {
      try {
        if (restoreOwner) {
          const [restore] = await owner<{ stmt: string }[]>`
            select format('ALTER TABLE household OWNER TO %I', ${restoreOwner}::text) as stmt
          `;
          if (restore?.stmt.startsWith("ALTER TABLE household OWNER TO ")) await owner.unsafe(restore.stmt);
        }
        if (houseA && houseB) {
          await owner`delete from household where id in (${houseA}, ${houseB})`;
        }
        await owner`delete from account where user_id in ${owner(users)}`;
        await owner`delete from "user" where id in ${owner(users)}`;
      } catch (cleanupError) {
        console.error(cleanupError);
      }
      await direct?.end({ timeout: 5 }).catch(() => undefined);
      if (closeApp) await closeApp().catch(() => undefined);
      await owner.end({ timeout: 5 }).catch(() => undefined);
    }
    if (failure) throw failure;
  });
});
