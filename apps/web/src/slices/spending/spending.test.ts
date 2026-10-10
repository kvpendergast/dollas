import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { defineSpendingFilter, type ColumnMapping, type ProviderAccount, type ProviderTransaction, type SpendingFilterInput } from "@dollas/domain";
import postgres from "postgres";
import { assertAppRoleSubjectToRls, migrateWithUrl } from "../../db/apply-migrations";
import { initTelemetry } from "../../lib/telemetry";

/**
 * PEN-212 against a real database, as members through RLS: attribution is
 * recorded on every write path; each filter narrows Activity's list alone and
 * combined; search covers payee and note; the dashboard counts the books by
 * category, account, and member; saved filters are shared by the household,
 * unique by name, and invisible to another household.
 */

const OWNER_URL = "postgresql://dollas:dollas@127.0.0.1:5432/dollas";
const APP_URL = "postgresql://dollas_app:dollas@127.0.0.1:5432/dollas";
const TODAY = "2026-10-10";

describe("spending filters, attribution, and saved filters (PEN-212)", () => {
  it("filters every way through one model and records who did what", async (t) => {
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
    const { createHouseholdTransaction, amendHouseholdTransaction, deleteHouseholdTransaction, listHouseholdTransactions } = await import(
      "../activity/transactions"
    );
    const { savePayeeRule, applyPayeeRule } = await import("../activity/payee-rule-service");
    const recurring = await import("../recurring/service");
    const spending = await import("./service");

    const stamp = randomBytes(4).toString("hex");
    const ids = { ada: randomUUID(), ben: randomUUID(), cy: randomUUID() };
    const houses: string[] = [];
    try {
      await owner`
        insert into "user" (id, name, email, email_verified) values
          (${ids.ada}, 'Ada', ${`ada-${stamp}@spending.test`}, true),
          (${ids.ben}, 'Ben', ${`ben-${stamp}@spending.test`}, true),
          (${ids.cy}, 'Cy', ${`cy-${stamp}@spending.test`}, true)
      `;
      const created = await owner<{ id: string; name: string }[]>`
        insert into household (name, created_by) values (${`Maple ${stamp}`}, ${ids.ada}), (${`Birch ${stamp}`}, ${ids.cy}) returning id, name
      `;
      const maple = created.find((row) => row.name.startsWith("Maple"))?.id ?? "";
      const birch = created.find((row) => row.name.startsWith("Birch"))?.id ?? "";
      houses.push(maple, birch);
      await owner`
        insert into household_member (household_id, user_id, role) values
          (${maple}, ${ids.ada}, 'owner'), (${maple}, ${ids.ben}, 'member'), (${birch}, ${ids.cy}, 'owner')
      `;
      const ada = { userId: ids.ada, householdId: maple };
      const ben = { userId: ids.ben, householdId: maple };
      const cy = { userId: ids.cy, householdId: birch };
      const accounts = await owner<{ id: string; name: string }[]>`
        insert into ledger_account (household_id, name, type, opening_balance_cents) values
          (${maple}, 'Checking', 'checking', 0), (${maple}, 'Card', 'credit', 0)
        returning id, name
      `;
      const checking = accounts.find((row) => row.name === "Checking")?.id ?? "";
      const card = accounts.find((row) => row.name === "Card")?.id ?? "";
      const [food] = await owner<{ id: string }[]>`insert into category_group (household_id, name, sort_order) values (${maple}, 'Food', 1) returning id`;
      const cats = await owner<{ id: string; name: string }[]>`
        insert into category (household_id, name, kind, sort_order, group_id) values
          (${maple}, 'Groceries', 'expense', 1, ${food.id}), (${maple}, 'Dining', 'expense', 2, ${food.id}),
          (${maple}, 'Housing', 'expense', 3, null), (${maple}, 'Paycheck', 'income', 4, null)
        returning id, name
      `;
      const cat = (name: string) => cats.find((row) => row.name === name)?.id ?? "";
      const add = async (who: { userId: string; householdId: string }, payee: string, occurredOn: string, amountCents: number, category: string, accountId = checking) => {
        const saved = await createHouseholdTransaction(who, { payee, occurredOn, accountId, amountCents, splits: [{ categoryId: cat(category), amountCents }] });
        assert.ok(saved.ok, JSON.stringify(saved));
        return saved.value.id;
      };

      // ---- Write paths record attribution. ----
      const market = await add(ada, "Corner Market", "2026-10-02", -2000, "Groceries");
      const cafe = await add(ben, "Blue Cafe", "2026-09-15", -700, "Dining", card);
      const rentOct = await add(ada, "Maple Property", "2026-10-01", -150000, "Housing");
      const pay = await add(ben, "Acme Payroll", "2026-10-05", 250000, "Paycheck");
      const csv = await commitCsvImport(ada, {
        csv: ["date,payee,amount,notes", "2026-10-03,Hardware Store,-45.00,fix the sink", "2026-10-04,Corner Market,-12.50,"].join("\n"),
        mapping: {
          hasHeader: true, dateColumn: 0, payeeColumn: 1, amountMode: "signed", amountColumn: 2, debitColumn: null, creditColumn: null,
          flipSign: false, dateOrder: null, accountMode: "fixed", accountColumn: null, fixedAccountId: checking, categoryColumn: null, notesColumn: 3,
        } satisfies ColumnMapping,
      });
      assert.ok(csv.ok && csv.value.added === 2, JSON.stringify(csv));
      const [hardware] = await owner<{ id: string }[]>`select id from "transaction" where household_id = ${maple} and payee = 'Hardware Store'`;
      const [csvMarket] = await owner<{ id: string }[]>`select id from "transaction" where household_id = ${maple} and payee = 'Corner Market' and import_fingerprint is not null`;
      const [batch] = await owner<{ created_by_user_id: string }[]>`select created_by_user_id from csv_import where household_id = ${maple}`;
      assert.equal(batch.created_by_user_id, ids.ada, "the import batch records who ran it");

      const [connection] = await owner<{ id: string }[]>`
        insert into bank_connection (household_id, provider_id, label, encrypted_access_token, key_version)
        values (${maple}, 'plaid', 'Plaid bank', ${`v1.${"A".repeat(20)}.${"B".repeat(20)}`}, 1) returning id
      `;
      const bankAccount: ProviderAccount = { providerAccountId: "plaid-card", name: "Plaid Card", type: "credit", currency: "USD", balanceCents: 0 };
      const bankTxn = (id: string, occurredOn: string, amountCents: number, payee: string): ProviderTransaction => ({
        providerTransactionId: id, providerAccountId: "plaid-card", occurredOn, payee, amountCents, pending: false,
      });
      await withActor(ben.userId, (tx) =>
        applyBankSync(tx, {
          householdId: maple, connectionId: connection.id, providerId: "plaid", since: "2026-08-01", accounts: [bankAccount],
          transactions: [bankTxn("b-1", "2026-10-06", -3300, "GAS N GO"), bankTxn("b-2", "2026-08-20", -5100, "BLUE CAFE")],
          modified: [], removed: [], nextCursor: "c1",
        }),
      );
      const [gas] = await owner<{ id: string }[]>`select id from "transaction" where household_id = ${maple} and bank_transaction_id = 'b-1'`;
      const [bankCafe] = await owner<{ id: string }[]>`select id from "transaction" where household_id = ${maple} and bank_transaction_id = 'b-2'`;
      // An old row from before attribution (an owner script), in the fallback category.
      const [fallback] = await owner<{ id: string }[]>`select id from category where household_id = ${maple} and name = 'Uncategorized' and kind = 'expense'`;
      const legacy = await owner.begin(async (sql) => {
        const [row] = await sql<{ id: string }[]>`
          insert into "transaction" (household_id, account_id, occurred_on, payee, amount_cents) values (${maple}, ${checking}, '2026-10-07', 'Mystery Shop', -999) returning id
        `;
        await sql`insert into transaction_split (transaction_id, household_id, category_id, amount_cents) values (${row.id}, ${maple}, ${fallback.id}, -999)`;
        return row;
      });
      const attribution = async (id: string) =>
        (await owner<{ created_by_user_id: string | null; categorized_by_user_id: string | null }[]>`
          select created_by_user_id, categorized_by_user_id from "transaction" where id = ${id}
        `)[0];
      assert.deepEqual(await attribution(market), { created_by_user_id: ids.ada, categorized_by_user_id: ids.ada }, "manual entry");
      assert.deepEqual(await attribution(cafe), { created_by_user_id: ids.ben, categorized_by_user_id: ids.ben });
      assert.deepEqual(await attribution(hardware.id), { created_by_user_id: ids.ada, categorized_by_user_id: ids.ada }, "CSV import");
      assert.deepEqual(await attribution(gas.id), { created_by_user_id: ids.ben, categorized_by_user_id: ids.ben }, "bank sync by Ben");
      assert.deepEqual(await attribution(legacy.id), { created_by_user_id: null, categorized_by_user_id: null }, "owner scripts and history stay Unknown");

      // Ben recategorizes Ada's entry; Ada changing only the amount does not change who categorized it.
      assert.ok((await amendHouseholdTransaction(ben, market, { splits: [{ categoryId: cat("Dining"), amountCents: -2000 }] })).ok);
      assert.deepEqual(await attribution(market), { created_by_user_id: ids.ada, categorized_by_user_id: ids.ben });
      assert.ok((await amendHouseholdTransaction(ada, market, { amountCents: -2100, splits: [{ categoryId: cat("Dining"), amountCents: -2100 }] })).ok);
      assert.equal((await attribution(market)).categorized_by_user_id, ids.ben, "amount-only edits keep the categorizer");
      assert.ok((await amendHouseholdTransaction(ada, market, { splits: [{ categoryId: cat("Groceries"), amountCents: -2100 }] })).ok);
      assert.equal((await attribution(market)).categorized_by_user_id, ids.ada);
      // A payee rule applied by Ben categorizes as Ben.
      const rule = await savePayeeRule(ben, { pattern: "hardware", categoryId: cat("Housing") });
      assert.ok(rule.ok);
      assert.ok((await applyPayeeRule(ben, rule.value.id)).ok);
      assert.deepEqual(await attribution(hardware.id), { created_by_user_id: ids.ada, categorized_by_user_id: ids.ben }, "payee rule apply");

      // Recurring link and a soft-deleted row.
      const rent = await recurring.createRecurringItem(ada, { name: "Rent", payeeMatch: "maple property", amountCents: -150000, cadence: "monthly", anchorDate: "2026-10-01" }, TODAY);
      assert.ok(rent.ok && rent.value.linked === 1);
      const gone = await add(ada, "Corner Market", "2026-10-08", -999, "Groceries");
      assert.ok((await deleteHouseholdTransaction(ada, gone)).ok);

      // ---- Each filter alone, then combined. ----
      const list = async (input: SpendingFilterInput, who = ada) => {
        const filter = defineSpendingFilter(input)._unsafeUnwrap();
        const listed = await listHouseholdTransactions(who, { limit: 100, offset: 0, spending: { filter, today: TODAY } });
        assert.ok(listed.ok, JSON.stringify(listed));
        return listed.value.items.map((row) => row.id).sort();
      };
      const sorted = (...values: string[]) => [...values].sort();
      const everything = sorted(market, cafe, rentOct, pay, hardware.id, csvMarket.id, gas.id, bankCafe.id, legacy.id);
      assert.deepEqual(await list({}), everything, "no filter: every live transaction");
      assert.deepEqual(await list({ range: "this_month" }), sorted(market, rentOct, pay, hardware.id, csvMarket.id, gas.id, legacy.id));
      assert.deepEqual(await list({ range: "last_month" }), sorted(cafe));
      assert.deepEqual(await list({ range: "custom", from: "2026-10-03", to: "2026-10-05" }), sorted(pay, hardware.id, csvMarket.id));
      assert.deepEqual(await list({ accountIds: [card] }), sorted(cafe));
      assert.deepEqual(await list({ categoryIds: [cat("Groceries")] }), sorted(market));
      assert.deepEqual(await list({ groupIds: [food.id] }), sorted(market, cafe));
      // The CSV market row had no category column and no rule, so it is in the fallback category too.
      assert.deepEqual(await list({ categoryIds: ["uncategorized"] }), sorted(legacy.id, csvMarket.id, gas.id, bankCafe.id));
      assert.deepEqual(await list({ categoryIds: ["uncategorized", cat("Paycheck")] }), sorted(legacy.id, csvMarket.id, gas.id, bankCafe.id, pay));
      assert.deepEqual(await list({ memberIds: [ids.ben], memberRole: "added" }), sorted(cafe, pay, gas.id, bankCafe.id));
      assert.deepEqual(await list({ memberIds: [ids.ben], memberRole: "categorized" }), sorted(cafe, pay, gas.id, bankCafe.id, hardware.id));
      assert.deepEqual(await list({ memberIds: [ids.ben] }), sorted(cafe, pay, gas.id, bankCafe.id, hardware.id), "either role");
      assert.deepEqual(await list({ memberIds: ["unknown"] }), sorted(legacy.id));
      assert.deepEqual(await list({ sources: ["bank"] }), sorted(gas.id, bankCafe.id));
      assert.deepEqual(await list({ sources: ["csv"] }), sorted(hardware.id, csvMarket.id));
      assert.deepEqual(await list({ sources: ["manual"] }), sorted(market, cafe, rentOct, pay, legacy.id));
      assert.deepEqual(await list({ sources: ["manual", "csv", "bank"] }), everything);
      assert.deepEqual(await list({ recurring: "linked" }), sorted(rentOct));
      assert.equal((await list({ recurring: "not_linked" })).length, everything.length - 1);
      assert.deepEqual(await list({ minCents: 3300, maxCents: 5100 }), sorted(hardware.id, gas.id, bankCafe.id), "size range, inclusive");
      assert.deepEqual(await list({ minCents: 200000 }), sorted(pay), "income counts by size too");
      assert.deepEqual(await list({ search: "corner" }), sorted(market, csvMarket.id), "payee, case-insensitive");
      assert.deepEqual(await list({ search: "SINK" }), sorted(hardware.id), "note");
      assert.deepEqual(await list({ search: "100%_" }), [], "LIKE wildcards are literal");
      assert.deepEqual(
        await list({ range: "this_month", groupIds: [food.id], categoryIds: ["uncategorized"], memberIds: [ids.ada, "unknown"], memberRole: "added", sources: ["manual"], maxCents: 5000 }),
        sorted(market, legacy.id),
        "combined",
      );
      assert.deepEqual(await list({ range: "this_month", sources: ["bank"], search: "gas", accountIds: [card] }), [], "the bank row is on the Plaid account, not Card");

      const listed = await listHouseholdTransactions(ada, { limit: 100, offset: 0, spending: { filter: defineSpendingFilter({ search: "hardware" })._unsafeUnwrap(), today: TODAY } });
      assert.ok(listed.ok);
      assert.deepEqual(
        { sources: listed.value.items[0].sources, addedBy: listed.value.items[0].addedBy?.name, categorizedBy: listed.value.items[0].categorizedBy?.name, note: listed.value.items[0].note },
        { sources: ["csv"], addedBy: "Ada", categorizedBy: "Ben", note: "fix the sink" },
      );

      // ---- Dashboard. ----
      const board = await spending.getSpendingBreakdown(ada, { range: "this_month" }, TODAY);
      assert.ok(board.ok, JSON.stringify(board));
      // Spent this month: market 2100 + rent 150000 + hardware 4500 + Uncategorized (csv market 1250, gas 3300, legacy 999).
      assert.equal(board.value.totals.incomeCents, 250000);
      assert.equal(board.value.totals.spentCents, 2100 + 150000 + 4500 + 1250 + 3300 + 999);
      assert.deepEqual(
        board.value.byCategory.find((row) => row.name === "Uncategorized"),
        { key: fallback.id, name: "Uncategorized", groupName: null, spentCents: 1250 + 3300 + 999, incomeCents: 0, transactionCount: 3 },
      );
      assert.equal(board.value.byCategory[0].name, "Housing");
      assert.equal(board.value.byCategory[0].spentCents, 154500);
      assert.deepEqual(
        board.value.byMember.map((row) => [row.name, row.spentCents]),
        [
          ["Ada", 2100 + 150000 + 4500 + 1250],
          ["Ben", 3300],
          ["Unknown", 999],
        ],
      );
      const categorizedBoard = await spending.getSpendingBreakdown(ada, { range: "this_month", memberRole: "categorized" }, TODAY);
      assert.ok(categorizedBoard.ok);
      assert.equal(categorizedBoard.value.byMember.find((row) => row.name === "Ben")?.spentCents, 4500 + 3300, "attributed by who categorized");
      // A category filter counts only the matching lines.
      const groceries = await spending.getSpendingBreakdown(ada, { range: "this_month", categoryIds: [cat("Groceries")] }, TODAY);
      assert.ok(groceries.ok);
      assert.equal(groceries.value.totals.spentCents, 2100);
      assert.deepEqual(groceries.value.byAccount.map((row) => row.name), ["Checking"]);
      assert.equal(groceries.value.trend.buckets.reduce((sum, bucket) => sum + bucket.spentCents, 0), 2100);
      const bad = await spending.getSpendingBreakdown(ada, { minCents: -1 }, TODAY);
      assert.equal(bad.ok, false);

      // ---- Saved filters: shared, unique by name, RLS. ----
      const saved = await spending.createSavedFilter(ada, { name: "  Food   this month ", filter: { range: "this_month", groupIds: [food.id] } });
      assert.ok(saved.ok, JSON.stringify(saved));
      assert.equal(saved.value.name, "Food this month");
      const benSees = await spending.listSavedFilters(ben);
      assert.ok(benSees.ok);
      assert.deepEqual(benSees.value.map((row) => [row.name, row.createdBy, row.filter.groupIds]), [["Food this month", "Ada", [food.id]]], "both members share it");
      const dupe = await spending.createSavedFilter(ben, { name: "food THIS month", filter: {} });
      assert.equal(dupe.ok, false);
      assert.match(dupe.ok ? "" : dupe.memberMessage, /already exists/);
      assert.equal((await spending.createSavedFilter(ben, { name: "Bad", filter: { range: "custom", from: "2026-02-01", to: "2026-01-01" } })).ok, false);
      assert.ok((await spending.renameSavedFilter(ben, saved.value.id, "Food, October")).ok);
      const cySees = await spending.listSavedFilters(cy);
      assert.ok(cySees.ok);
      assert.deepEqual(cySees.value, [], "another household sees none");
      const cyRename = await spending.renameSavedFilter(cy, saved.value.id, "Mine now");
      assert.equal(cyRename.ok, false);
      const cyDelete = await spending.deleteSavedFilter(cy, saved.value.id);
      assert.equal(cyDelete.ok, false);
      assert.equal((await spending.getSavedFilter(cy, saved.value.id)).ok, false);
      // Cy cannot write into Maple by naming it either.
      const forged = await spending.createSavedFilter({ userId: ids.cy, householdId: maple }, { name: "Forged", filter: {} });
      assert.equal(forged.ok, false);
      // Nor read Maple's transactions or breakdown.
      assert.deepEqual(await list({}, { userId: ids.cy, householdId: maple }), []);
      const cyBoard = await spending.getSpendingBreakdown({ userId: ids.cy, householdId: maple }, {}, TODAY);
      assert.ok(cyBoard.ok && cyBoard.value.totals.transactionCount === 0);
      const removed = await spending.deleteSavedFilter(ada, saved.value.id);
      assert.ok(removed.ok && removed.value.name === "Food, October");
      assert.equal((await spending.deleteSavedFilter(ada, saved.value.id)).ok, false);
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
