import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import {
  DELETE_CONFIRMATION_MESSAGE,
  LAST_OWNER_MESSAGE,
  LastOwnerError,
  memberFacingMessage,
} from "@dollas/domain";
import { withActor } from "../../db/actor";
import { assertAppRoleSubjectToRls, migrateWithUrl } from "../../db/apply-migrations";
import { openAppDatabase } from "../../db/client";
import { household, transaction } from "../../db/schema";
import { initTelemetry } from "../../lib/telemetry";
import { deleteHousehold, leaveHousehold, transferOwnership, updateProfileName } from "./membership";

const OWNER_URL = "postgresql://dollas:dollas@127.0.0.1:5432/dollas";
const APP_URL = "postgresql://dollas_app:dollas@127.0.0.1:5432/dollas";

describe("household membership services", () => {
  it("changes a name, blocks the last owner, hands off, leaves, and deletes only that household", async (t) => {
    initTelemetry();
    const host = new URL(OWNER_URL).hostname;
    assert.ok(host === "127.0.0.1" || host === "localhost");
    const owner = postgres(OWNER_URL, { max: 1, prepare: false, connect_timeout: 5, onnotice() {} });
    try {
      await owner`select 1`;
    } catch (error) {
      await owner.end({ timeout: 1 }).catch(() => undefined);
      if (process.env.CI) throw error;
      t.skip("Postgres is not running on 127.0.0.1:5432");
      return;
    }

    const ada = crypto.randomUUID();
    const bea = crypto.randomUUID();
    const cam = crypto.randomUUID();
    const users = [ada, bea, cam];
    let houseA = "";
    let houseB = "";
    let closeApp: (() => Promise<void>) | undefined;
    let failure: unknown;

    try {
      const appRole = await owner<{ n: string }[]>`
        select count(*)::text as n from pg_roles where rolname = 'dollas_app'
      `;
      if (appRole[0]?.n === "0") {
        await owner.unsafe("CREATE ROLE dollas_app LOGIN PASSWORD 'dollas' NOSUPERUSER NOBYPASSRLS");
      }
      await migrateWithUrl(OWNER_URL, { env: { DATABASE_URL: APP_URL } });
      await assertAppRoleSubjectToRls(OWNER_URL);
      const app = openAppDatabase(OWNER_URL, 1);
      closeApp = () => app.close();

      await owner`
        insert into "user" (id, name, email, email_verified)
        values
          (${ada}, 'Ada', ${`${ada}@example.test`}, true),
          (${bea}, 'Bea', ${`${bea}@example.test`}, true),
          (${cam}, 'Cam', ${`${cam}@example.test`}, true)
      `;
      const houses = await owner<{ id: string; name: string }[]>`
        insert into household (name, created_by)
        values ('Maple House', ${ada}), ('Other House', ${cam})
        returning id, name
      `;
      houseA = houses.find((row) => row.name === "Maple House")?.id ?? "";
      houseB = houses.find((row) => row.name === "Other House")?.id ?? "";
      assert.ok(houseA && houseB);
      await owner`
        insert into household_member (household_id, user_id, role)
        values
          (${houseA}, ${ada}, 'owner'),
          (${houseB}, ${cam}, 'owner')
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
      const transactionA = await ledger(houseA, "Rent A");
      const transactionB = await ledger(houseB, "Rent B");

      const renamed = await updateProfileName({ userId: ada, householdId: houseA }, "  Ada   Maple ", app.db);
      assert.equal(renamed.ok, true);
      if (renamed.ok) assert.equal(renamed.value.name, "Ada Maple");
      const [camName] = await owner<{ name: string }[]>`select name from "user" where id = ${cam}`;
      assert.equal(camName?.name, "Cam");

      const blocked = await leaveHousehold({ userId: ada, householdId: houseA }, app.db);
      assert.equal(blocked.ok, false);
      if (!blocked.ok) {
        assert.ok(blocked.error instanceof LastOwnerError);
        assert.equal(blocked.memberMessage, LAST_OWNER_MESSAGE);
        assert.equal(memberFacingMessage(blocked.error), LAST_OWNER_MESSAGE);
      }
      const [stillOwner] = await owner<{ n: string }[]>`
        select count(*)::text as n from household_member where household_id = ${houseA} and user_id = ${ada} and role = 'owner'
      `;
      assert.equal(stillOwner?.n, "1");

      await owner`
        insert into household_member (household_id, user_id, role)
        values (${houseA}, ${bea}, 'member')
      `;
      const stillLast = await leaveHousehold({ userId: ada, householdId: houseA }, app.db);
      assert.equal(stillLast.ok, false);
      if (!stillLast.ok) assert.equal(stillLast.memberMessage, LAST_OWNER_MESSAGE);

      const memberHandoff = await transferOwnership({ userId: bea, householdId: houseA }, ada, app.db);
      assert.equal(memberHandoff.ok, false);

      const handed = await transferOwnership({ userId: ada, householdId: houseA }, bea, app.db);
      assert.equal(handed.ok, true);
      const roles = await owner<{ user_id: string; role: string }[]>`
        select user_id, role from household_member where household_id = ${houseA} order by user_id
      `;
      assert.equal(roles.find((row) => row.user_id === ada)?.role, "member");
      assert.equal(roles.find((row) => row.user_id === bea)?.role, "owner");

      const memberDelete = await deleteHousehold({ userId: ada, householdId: houseA }, "Maple House", app.db);
      assert.equal(memberDelete.ok, false);
      if (!memberDelete.ok) assert.equal(memberDelete.memberMessage, "Only an owner can delete the household.");

      const left = await leaveHousehold({ userId: ada, householdId: houseA }, app.db);
      assert.equal(left.ok, true);
      const [adaGone] = await owner<{ n: string }[]>`
        select count(*)::text as n from household_member where household_id = ${houseA} and user_id = ${ada}
      `;
      assert.equal(adaGone?.n, "0");
      const [houseStill] = await owner<{ n: string }[]>`select count(*)::text as n from household where id = ${houseA}`;
      assert.equal(houseStill?.n, "1");

      const outsider = await deleteHousehold({ userId: cam, householdId: houseA }, "Maple House", app.db);
      assert.equal(outsider.ok, false);

      const wrongName = await deleteHousehold({ userId: bea, householdId: houseA }, "maple house", app.db);
      assert.equal(wrongName.ok, false);
      if (!wrongName.ok) assert.equal(wrongName.memberMessage, DELETE_CONFIRMATION_MESSAGE);
      const [txBefore] = await owner<{ n: string }[]>`select count(*)::text as n from transaction where id = ${transactionA}`;
      assert.equal(txBefore?.n, "1");

      await assert.rejects(() =>
        withActor(bea, (tx) => tx.delete(household).where(eq(household.id, houseA)), app.db),
      );

      const removed = await deleteHousehold({ userId: bea, householdId: houseA }, "Maple House", app.db);
      assert.equal(removed.ok, true);
      const [goneHouse] = await owner<{ n: string }[]>`select count(*)::text as n from household where id = ${houseA}`;
      const [goneTx] = await owner<{ n: string }[]>`select count(*)::text as n from transaction where id = ${transactionA}`;
      const [goneMember] = await owner<{ n: string }[]>`
        select count(*)::text as n from household_member where household_id = ${houseA}
      `;
      const [otherHouse] = await owner<{ name: string }[]>`select name from household where id = ${houseB}`;
      const [otherTx] = await owner<{ id: string }[]>`select id from transaction where id = ${transactionB}`;
      const [otherMember] = await owner<{ role: string }[]>`
        select role from household_member where household_id = ${houseB} and user_id = ${cam}
      `;
      assert.equal(goneHouse?.n, "0");
      assert.equal(goneTx?.n, "0");
      assert.equal(goneMember?.n, "0");
      assert.equal(otherHouse?.name, "Other House");
      assert.equal(otherTx?.id, transactionB);
      assert.equal(otherMember?.role, "owner");

      const visible = await withActor(cam, (tx) => tx.select({ id: transaction.id }).from(transaction), app.db);
      assert.deepEqual(
        visible.map((row) => row.id),
        [transactionB],
      );
      const adaHouses = await withActor(ada, (tx) => tx.select({ id: household.id }).from(household), app.db);
      assert.equal(
        adaHouses.some((row) => row.id === houseA || row.id === houseB),
        false,
      );
      const [adaUser] = await owner<{ name: string }[]>`select name from "user" where id = ${ada}`;
      assert.equal(adaUser?.name, "Ada Maple");
    } catch (error) {
      failure = error;
    } finally {
      try {
        if (houseA) await owner`delete from household where id = ${houseA}`;
        if (houseB) await owner`delete from household where id = ${houseB}`;
        await owner`delete from "user" where id in ${owner(users)}`;
      } catch (cleanupError) {
        console.error(cleanupError);
      }
      if (closeApp) await closeApp().catch(() => undefined);
      await owner.end({ timeout: 5 }).catch(() => undefined);
    }
    if (failure) throw failure;
  });
});
