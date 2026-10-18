import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { defineSpendingFilter, type ColumnMapping } from "@dollas/domain";
import postgres from "postgres";
import { assertAppRoleSubjectToRls, migrateWithUrl } from "../../db/apply-migrations";
import { initTelemetry } from "../../lib/telemetry";

/** Transaction notes through the services, as a member through RLS: trim, clear, cap, keep on every other edit. */

const OWNER_URL = "postgresql://dollas:dollas@127.0.0.1:5432/dollas";
const APP_URL = "postgresql://dollas_app:dollas@127.0.0.1:5432/dollas";

describe("transaction note", () => {
  it("is set, trimmed, cleared, capped, and survives other edits and re-imports", async (t) => {
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
    await migrateWithUrl(OWNER_URL, { env: { DATABASE_URL: APP_URL } });
    await assertAppRoleSubjectToRls(OWNER_URL);
    process.env.DATABASE_URL = OWNER_URL;
    const { createHouseholdTransaction, amendHouseholdTransaction, deleteHouseholdTransaction, restoreHouseholdTransaction, listHouseholdTransactions } =
      await import("./transactions");
    const { commitCsvImport } = await import("./csv-import-service");
    const stamp = randomBytes(4).toString("hex");
    const userId = randomUUID();
    let house = "";
    try {
      await owner`insert into "user" (id, name, email, email_verified) values (${userId}, 'Ada', ${`ada-${stamp}@note.test`}, true)`;
      const [created] = await owner<{ id: string }[]>`insert into household (name, created_by) values (${`Note ${stamp}`}, ${userId}) returning id`;
      house = created.id;
      await owner`insert into household_member (household_id, user_id, role) values (${house}, ${userId}, 'owner')`;
      const [account] = await owner<{ id: string }[]>`insert into ledger_account (household_id, name, type, opening_balance_cents) values (${house}, 'Checking', 'checking', 0) returning id`;
      const cats = await owner<{ id: string; name: string }[]>`
        insert into category (household_id, name, kind, sort_order) values (${house}, 'Groceries', 'expense', 1), (${house}, 'Dining', 'expense', 2) returning id, name`;
      const groceries = cats.find((row) => row.name === "Groceries")?.id ?? "";
      const dining = cats.find((row) => row.name === "Dining")?.id ?? "";
      const me = { userId, householdId: house };
      const noteOf = async (id: string) => (await owner<{ note: string | null }[]>`select note from "transaction" where id = ${id}`)[0]?.note;
      const base = { accountId: account.id, occurredOn: "2026-10-02", payee: "Corner Market", amountCents: -2000, splits: [{ categoryId: groceries, amountCents: -2000 }] };

      // Create: trimmed; blank is null; absent is null.
      const withNote = await createHouseholdTransaction(me, { ...base, note: "  birthday party  " });
      assert.ok(withNote.ok);
      assert.equal(await noteOf(withNote.value.id), "birthday party");
      const blank = await createHouseholdTransaction(me, { ...base, payee: "Blank", note: "   " });
      const absent = await createHouseholdTransaction(me, { ...base, payee: "Absent" });
      assert.ok(blank.ok && absent.ok);
      assert.equal(await noteOf(blank.value.id), null);
      assert.equal(await noteOf(absent.value.id), null);

      // Cap: 500 allowed, 501 refused, nothing saved.
      const longest = await createHouseholdTransaction(me, { ...base, payee: "Long", note: "x".repeat(500) });
      assert.ok(longest.ok);
      const tooLong = await createHouseholdTransaction(me, { ...base, payee: "TooLong", note: "x".repeat(501) });
      assert.ok(!tooLong.ok);
      assert.equal((await owner`select 1 from "transaction" where household_id = ${house} and payee = 'TooLong'`).length, 0);

      // Update: omitted keeps; text changes; blank or null clears.
      const id = withNote.value.id;
      assert.ok((await amendHouseholdTransaction(me, id, { payee: "Corner Market 2" })).ok);
      assert.equal(await noteOf(id), "birthday party", "an edit that leaves note out keeps it");
      assert.ok((await amendHouseholdTransaction(me, id, { note: " cake and candles " })).ok);
      assert.equal(await noteOf(id), "cake and candles");

      // Categorize and split keep it.
      assert.ok((await amendHouseholdTransaction(me, id, { categoryId: dining })).ok);
      assert.equal(await noteOf(id), "cake and candles", "categorize keeps the note");
      assert.ok((await amendHouseholdTransaction(me, id, { splits: [{ categoryId: groceries, amountCents: -1500 }, { categoryId: dining, amountCents: -500 }] })).ok);
      assert.equal(await noteOf(id), "cake and candles", "split keeps the note");
      assert.ok((await amendHouseholdTransaction(me, id, { categoryId: groceries, note: "new" })).ok, "categorize may set a note too");
      assert.equal(await noteOf(id), "new");

      // Delete and restore keep it.
      assert.ok((await deleteHouseholdTransaction(me, id)).ok);
      assert.equal(await noteOf(id), "new");
      assert.ok((await restoreHouseholdTransaction(me, id)).ok);
      assert.equal(await noteOf(id), "new");

      // List returns it; search matches it.
      const listed = await listHouseholdTransactions(me, { limit: 50, offset: 0 });
      assert.ok(listed.ok);
      assert.equal(listed.value.items.find((item) => item.id === id)?.note, "new");
      const searched = await listHouseholdTransactions(me, {
        limit: 50,
        offset: 0,
        spending: { filter: defineSpendingFilter({ search: "NEW" })._unsafeUnwrap(), today: "2026-10-10" },
      });
      assert.ok(searched.ok);
      assert.deepEqual(searched.value.items.map((item) => item.id), [id], "search matches the note, case-insensitive");

      // Clear.
      assert.ok((await amendHouseholdTransaction(me, id, { note: "" })).ok);
      assert.equal(await noteOf(id), null);
      assert.ok((await amendHouseholdTransaction(me, id, { note: "again" })).ok);
      assert.ok((await amendHouseholdTransaction(me, id, { note: null })).ok);
      assert.equal(await noteOf(id), null);

      // CSV re-import never overwrites an edited note, and the note is not part of the identity.
      const mapping = {
        hasHeader: true, dateColumn: 0, payeeColumn: 1, amountMode: "signed", amountColumn: 2, debitColumn: null, creditColumn: null,
        flipSign: false, dateOrder: null, accountMode: "fixed", accountColumn: null, fixedAccountId: account.id, categoryColumn: null, notesColumn: 3,
      } satisfies ColumnMapping;
      const csv = (note: string) => ["date,payee,amount,notes", `2026-10-03,Hardware Store,-45.00,${note}`].join("\n");
      const first = await commitCsvImport(me, { csv: csv("fix the sink"), mapping });
      assert.ok(first.ok && first.value.added === 1);
      const [hardware] = await owner<{ id: string }[]>`select id from "transaction" where household_id = ${house} and payee = 'Hardware Store'`;
      assert.equal(await noteOf(hardware.id), "fix the sink");
      assert.ok((await amendHouseholdTransaction(me, hardware.id, { note: "my own words" })).ok);
      const again = await commitCsvImport(me, { csv: csv("fix the sink"), mapping });
      assert.ok(again.ok && again.value.added === 0, "same row is a duplicate");
      const reworded = await commitCsvImport(me, { csv: csv("a different bank memo"), mapping });
      assert.ok(reworded.ok && reworded.value.added === 0, "a different note does not make it a new transaction");
      assert.equal(await noteOf(hardware.id), "my own words");
    } finally {
      if (house) {
        await owner`delete from household where id = ${house}`.catch(() => undefined);
      }
      await owner`delete from "user" where id = ${userId}`.catch(() => undefined);
      await owner.end({ timeout: 2 });
      const { closeDb } = await import("../../db/client");
      await closeDb();
    }
  });
});
