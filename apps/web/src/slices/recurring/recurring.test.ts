import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { ColumnMapping, ProviderAccount, ProviderTransaction } from "@dollas/domain";
import postgres from "postgres";
import { assertAppRoleSubjectToRls, migrateWithUrl } from "../../db/apply-migrations";
import { initTelemetry } from "../../lib/telemetry";

/**
 * PEN-206 against a real database, as members through RLS: creating an item
 * backfills history; manual entry, CSV import, and bank sync link new
 * transactions; one transaction per occurrence; PEN-203's merged row is the
 * one linked; a member's unlink survives later syncs and edits; soft-deleted
 * transactions free their occurrence; expected amounts split paid from still
 * expected; and another household can neither see nor link anything.
 * Cadence math, tolerance, windows, and payee normalization are unit-tested in
 * the domain package.
 */

const OWNER_URL = "postgresql://dollas:dollas@127.0.0.1:5432/dollas";
const APP_URL = "postgresql://dollas_app:dollas@127.0.0.1:5432/dollas";
const TODAY = "2026-10-10";

function mappingFor(accountId: string): ColumnMapping {
  return {
    hasHeader: true,
    dateColumn: 0,
    payeeColumn: 1,
    amountMode: "signed",
    amountColumn: 2,
    debitColumn: null,
    creditColumn: null,
    flipSign: false,
    dateOrder: null,
    accountMode: "fixed",
    accountColumn: null,
    fixedAccountId: accountId,
    categoryColumn: null,
    notesColumn: null,
  };
}

describe("recurring items link matching transactions (PEN-206)", () => {
  it("links from every path, once per occurrence, and keeps a member's unlink", async (t) => {
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
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM;

    const { withActor } = await import("../../db/actor");
    const { applyBankSync } = await import("../connections/apply");
    const { commitCsvImport } = await import("../activity/csv-import-service");
    const { createHouseholdTransaction, deleteHouseholdTransaction, restoreHouseholdTransaction, listHouseholdTransactions } = await import(
      "../activity/transactions"
    );
    const service = await import("./service");

    const stamp = randomBytes(4).toString("hex");
    const ids = { ada: randomUUID(), cy: randomUUID() };
    const houses: string[] = [];
    try {
      await owner`
        insert into "user" (id, name, email, email_verified) values
          (${ids.ada}, 'Ada', ${`ada-${stamp}@recurring.test`}, true),
          (${ids.cy}, 'Cy', ${`cy-${stamp}@recurring.test`}, true)
      `;
      const created = await owner<{ id: string; name: string }[]>`
        insert into household (name, created_by) values (${`Maple ${stamp}`}, ${ids.ada}), (${`Birch ${stamp}`}, ${ids.cy})
        returning id, name
      `;
      const maple = created.find((row) => row.name.startsWith("Maple"))?.id ?? "";
      const birch = created.find((row) => row.name.startsWith("Birch"))?.id ?? "";
      houses.push(maple, birch);
      await owner`insert into household_member (household_id, user_id, role) values (${maple}, ${ids.ada}, 'owner'), (${birch}, ${ids.cy}, 'owner')`;
      const ada = { userId: ids.ada, householdId: maple };
      const cy = { userId: ids.cy, householdId: birch };
      const [checking] = await owner<{ id: string }[]>`
        insert into ledger_account (household_id, name, type, opening_balance_cents) values (${maple}, 'Plaid Checking', 'checking', 0) returning id
      `;
      const [housing] = await owner<{ id: string }[]>`
        insert into category (household_id, name, kind, sort_order) values (${maple}, 'Housing', 'expense', 1) returning id
      `;
      const [birchChecking] = await owner<{ id: string }[]>`
        insert into ledger_account (household_id, name, type, opening_balance_cents) values (${birch}, 'Checking', 'checking', 0) returning id
      `;
      const [birchCategory] = await owner<{ id: string }[]>`
        insert into category (household_id, name, kind, sort_order) values (${birch}, 'Home', 'expense', 1) returning id
      `;
      const linksOf = (itemId: string) =>
        owner<{ transaction_id: string; occurrence_date: string; source: string }[]>`
          select transaction_id, occurrence_date::text, source from recurring_link where recurring_item_id = ${itemId} order by occurrence_date
        `;
      const typed = async (payee: string, occurredOn: string, amountCents: number) => {
        const saved = await createHouseholdTransaction(ada, {
          payee,
          occurredOn,
          accountId: checking.id,
          amountCents,
          splits: [{ categoryId: housing.id, amountCents }],
        });
        assert.ok(saved.ok, JSON.stringify(saved));
        return saved.value.id;
      };

      // ---- Backfill: history typed in before the item exists links when it is created. ----
      const augRent = await typed("Maple Property Mgmt", "2026-08-01", -150000);
      const tooOld = await typed("Maple Property Mgmt", "2026-03-01", -150000);
      const rent = await service.createRecurringItem(
        ada,
        { name: "Rent", payeeMatch: "  MAPLE property ", amountCents: -150000, cadence: "monthly", anchorDate: "2026-08-01", categoryId: housing.id, accountId: checking.id },
        TODAY,
      );
      assert.ok(rent.ok, JSON.stringify(rent));
      assert.equal(rent.value.linked, 1, "backfill links the August rent; March is past the 180-day lookback");
      const rentId = rent.value.id;
      assert.deepEqual(
        (await linksOf(rentId)).map((row) => [row.transaction_id, row.occurrence_date, row.source]),
        [[augRent, "2026-08-01", "auto"]],
      );
      assert.notEqual(tooOld, augRent);

      // ---- CSV import links (payee normalized, amount within 5%, date within 3 days). ----
      const csv = ["date,payee,amount", "2026-09-03,MAPLE PROPERTY MGMT ACH,-1525.00", "2026-09-02,Maple Property late fee,-25.00"].join("\n");
      const imported = await commitCsvImport(ada, { csv, mapping: mappingFor(checking.id) });
      assert.ok(imported.ok && imported.value.added === 2, JSON.stringify(imported));
      const septRent = (await owner<{ id: string }[]>`select id from "transaction" where account_id = ${checking.id} and amount_cents = -152500`)[0].id;
      assert.deepEqual((await linksOf(rentId)).map((row) => row.transaction_id), [augRent, septRent], "the late fee is outside tolerance");

      // ---- Manual entry links; a second rent the same month does not (one per occurrence). ----
      const octRent = await typed("Maple Property", "2026-10-01", -151000);
      const octDouble = await typed("Maple Property", "2026-10-02", -150000);
      const octLinks = (await linksOf(rentId)).filter((row) => row.occurrence_date === "2026-10-01");
      assert.deepEqual(octLinks.map((row) => row.transaction_id), [octRent]);

      // ---- Soft-deleted transactions do not count; their occurrence frees up. ----
      assert.ok((await deleteHouseholdTransaction(ada, octRent)).ok);
      const afterDelete = await service.getRecurringItem(ada, rentId, TODAY);
      assert.ok(afterDelete.ok);
      assert.equal(afterDelete.value.occurrences.find((row) => row.date === "2026-10-01")?.status, "missed");
      // An edit of the item re-runs matching: the live October rent takes the occurrence.
      const edited = await service.updateRecurringItem(ada, rentId, { windowDays: 4 }, TODAY);
      assert.ok(edited.ok && edited.value.linked === 1, JSON.stringify(edited));
      assert.deepEqual((await linksOf(rentId)).filter((row) => row.occurrence_date === "2026-10-01").map((row) => row.transaction_id), [octDouble]);
      assert.ok((await restoreHouseholdTransaction(ada, octRent)).ok);
      assert.equal((await owner`select 1 from recurring_link where transaction_id = ${octRent}`).length, 0, "restoring does not steal a filled occurrence");

      // ---- Bank sync links, and PEN-203's merged row is the one linked. ----
      const streaming = await service.createRecurringItem(
        ada,
        { name: "Streaming", payeeMatch: "stream", amountCents: -999, cadence: "monthly", anchorDate: "2026-08-15" },
        TODAY,
      );
      assert.ok(streaming.ok && streaming.value.linked === 0);
      const streamId = streaming.value.id;
      const csvStream = await commitCsvImport(ada, { csv: ["date,payee,amount", "2026-09-15,Streaming Co,-9.99"].join("\n"), mapping: mappingFor(checking.id) });
      assert.ok(csvStream.ok && csvStream.value.added === 1);
      const csvStreamId = (await owner<{ id: string }[]>`select id from "transaction" where account_id = ${checking.id} and payee = 'Streaming Co'`)[0].id;
      assert.deepEqual((await linksOf(streamId)).map((row) => row.transaction_id), [csvStreamId], "CSV row links on import");

      const [connection] = await owner<{ id: string }[]>`
        insert into bank_connection (household_id, provider_id, label, encrypted_access_token, key_version)
        values (${maple}, 'plaid', 'Plaid bank', ${`v1.${"A".repeat(20)}.${"B".repeat(20)}`}, 1) returning id
      `;
      const account: ProviderAccount = { providerAccountId: "plaid-checking", name: "Plaid Checking", type: "checking", currency: "USD", balanceCents: 0 };
      const txn = (id: string, occurredOn: string, amountCents: number, payee = "STREAMING SVC"): ProviderTransaction => ({
        providerTransactionId: id,
        providerAccountId: "plaid-checking",
        occurredOn,
        payee,
        amountCents,
        pending: false,
      });
      const sync = (page: { added?: ProviderTransaction[]; modified?: ProviderTransaction[] }) =>
        withActor(ada.userId, (tx) =>
          applyBankSync(tx, {
            householdId: maple,
            connectionId: connection.id,
            providerId: "plaid",
            since: "2026-08-01",
            accounts: [account],
            transactions: page.added ?? [],
            modified: page.modified ?? [],
            removed: [],
            nextCursor: `cursor-${randomBytes(3).toString("hex")}`,
          }),
        );
      const first = await sync({ added: [txn("stream-aug", "2026-08-16", -999), txn("stream-sep", "2026-09-16", -999)] });
      assert.equal(first.transactions, 1, "August is new");
      assert.equal(first.matched, 1, "September merged into the CSV row");
      const augStream = (await owner<{ id: string }[]>`select id from "transaction" where bank_transaction_id = 'stream-aug'`)[0].id;
      assert.deepEqual(
        (await linksOf(streamId)).map((row) => [row.transaction_id, row.occurrence_date]),
        [
          [augStream, "2026-08-15"],
          [csvStreamId, "2026-09-15"],
        ],
      );
      const [septCount] = await owner<{ n: number }[]>`
        select count(*)::int as n from "transaction" where account_id = ${checking.id} and amount_cents = -999 and occurred_on between '2026-09-10' and '2026-09-20'
      `;
      assert.equal(septCount.n, 1, "one transaction for the September charge");
      const listed = await listHouseholdTransactions(ada, { limit: 50, offset: 0, payeeContains: "stream" });
      assert.ok(listed.ok);
      assert.deepEqual(
        listed.value.items.map((row) => row.recurring?.name),
        ["Streaming", "Streaming"],
        "Activity shows the item on linked rows",
      );

      // ---- Unlink sticks: a later sync and an item edit do not relink the pair. ----
      const unlinked = await service.unlinkRecurringTransaction(ada, augStream);
      assert.ok(unlinked.ok && unlinked.value.name === "Streaming");
      await sync({ modified: [txn("stream-aug", "2026-08-16", -1000)] });
      await sync({ added: [txn("stream-aug", "2026-08-16", -1000)] });
      assert.ok((await service.updateRecurringItem(ada, streamId, { tolerancePercent: 10 }, TODAY)).ok);
      assert.equal((await owner`select 1 from recurring_link where transaction_id = ${augStream}`).length, 0);
      // The member can link it back by hand; that clears the dismissal.
      const relinked = await service.linkRecurringTransaction(ada, streamId, augStream);
      assert.ok(relinked.ok && relinked.value.occurrenceDate === "2026-08-15", JSON.stringify(relinked));
      assert.equal((await owner`select 1 from recurring_dismissal where transaction_id = ${augStream}`).length, 0);

      // ---- Paused items stop matching. ----
      assert.ok((await service.setRecurringItemPaused(ada, streamId, true, TODAY)).ok);
      await sync({ added: [txn("stream-oct", "2026-10-12", -999)] });
      const octStream = (await owner<{ id: string }[]>`select id from "transaction" where bank_transaction_id = 'stream-oct'`)[0].id;
      assert.equal((await owner`select 1 from recurring_link where transaction_id = ${octStream}`).length, 0);
      const resumed = await service.setRecurringItemPaused(ada, streamId, false, TODAY);
      assert.ok(resumed.ok && resumed.value.linked === 1, "resuming links what arrived while paused");

      // ---- Expected amounts for PEN-205: October is paid rent plus the streaming charge. ----
      const october = await service.loadExpectedRecurring(ada, { from: "2026-10-01", to: "2026-10-31" }, TODAY);
      assert.ok(october.ok);
      assert.deepEqual(october.value.paid, { incomeCents: 0, expenseCents: 150000 + 999, count: 2 });
      assert.deepEqual(october.value.expected, { incomeCents: 0, expenseCents: 0, count: 0 });
      const november = await service.loadExpectedRecurring(ada, { from: "2026-11-01", to: "2026-11-30" }, TODAY);
      assert.ok(november.ok);
      assert.deepEqual(november.value.expected, { incomeCents: 0, expenseCents: 150000 + 999, count: 2 });

      // ---- List and month status. ----
      const list = await service.listRecurringItems(ada, TODAY);
      assert.ok(list.ok);
      assert.deepEqual(
        list.value.map((row) => [row.name, row.nextDate, row.monthStatus]),
        [
          ["Rent", "2026-11-01", "paid"],
          ["Streaming", "2026-11-15", "paid"],
        ],
        "October is paid for both, so each next date is November",
      );

      // ---- RLS: Birch sees nothing and cannot link, unlink, edit, or delete Maple's items. ----
      const seen = await withActor(cy.userId, (tx) => tx.execute("select count(*)::int as n from recurring_item"));
      assert.equal((seen as unknown as Array<{ n: number }>)[0]?.n, 0);
      const cyList = await service.listRecurringItems(cy, TODAY);
      assert.ok(cyList.ok && cyList.value.length === 0);
      assert.equal((await service.getRecurringItem(cy, rentId, TODAY)).ok, false);
      assert.equal((await service.updateRecurringItem(cy, rentId, { name: "Hijacked" }, TODAY)).ok, false);
      assert.equal((await service.deleteRecurringItem(cy, rentId)).ok, false);
      assert.equal((await service.unlinkRecurringTransaction(cy, augRent)).ok, false);
      assert.equal((await service.linkRecurringTransaction(cy, rentId, octRent)).ok, false);
      const birchItem = await service.createRecurringItem(
        cy,
        { name: "Mortgage", payeeMatch: "maple property", amountCents: -150000, cadence: "monthly", anchorDate: "2026-08-01", categoryId: birchCategory.id },
        TODAY,
      );
      assert.ok(birchItem.ok && birchItem.value.linked === 0, "Birch's item never links Maple's transactions");
      assert.equal((await service.linkRecurringTransaction(cy, birchItem.value.id, octRent)).ok, false);
      assert.equal(
        (await service.createRecurringItem(cy, { name: "Sneaky", amountCents: -1, cadence: "monthly", anchorDate: "2026-08-01", accountId: checking.id }, TODAY)).ok,
        false,
        "an item cannot point at another household's account",
      );
      // Even the owner connection cannot write a cross-household link.
      await assert.rejects(
        owner`insert into recurring_link (household_id, recurring_item_id, transaction_id, occurrence_date, source) values (${birch}, ${birchItem.value.id}, ${octRent}, '2026-10-01', 'manual')`,
        /same household/,
      );
      const [{ name: rentName }] = await owner<{ name: string }[]>`select name from recurring_item where id = ${rentId}`;
      assert.equal(rentName, "Rent");
      assert.notEqual(birchChecking.id, checking.id);

      // ---- Deleting an item keeps its transactions. ----
      const removed = await service.deleteRecurringItem(ada, rentId);
      assert.ok(removed.ok && removed.value.unlinked === 3, JSON.stringify(removed));
      assert.equal((await owner`select 1 from "transaction" where id = ${augRent}`).length, 1);
      assert.equal((await owner`select 1 from recurring_link where recurring_item_id = ${rentId}`).length, 0);
    } finally {
      try {
        for (const house of houses) await owner`delete from household where id = ${house}`;
        for (const id of Object.values(ids)) await owner`delete from "user" where id = ${id}`;
      } finally {
        await owner.end({ timeout: 1 });
        const { closeDb } = await import("../../db/client");
        await closeDb();
      }
    }
  });
});
