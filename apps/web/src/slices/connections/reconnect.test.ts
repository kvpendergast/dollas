import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import type { ProviderAccount, ProviderTransaction } from "@dollas/domain";
import postgres from "postgres";
import { assertAppRoleSubjectToRls, migrateWithUrl } from "../../db/apply-migrations";
import { initTelemetry } from "../../lib/telemetry";

/**
 * PEN-251 against a real database, as members through RLS. A Plaid relink
 * after a disconnect is a new item: new account ids and new transaction ids
 * for charges already in the books. The sync reattaches the old account and
 * re-keys the old rows instead of adding a second account and second copies.
 * Covers: no duplicates and member edits kept (payee, note, category, a
 * recurring link, attribution, a soft delete), a separated pair staying
 * separate, re-running (and a same-item / update-mode sync with stable ids)
 * as a no-op, the active-item guard, SimpleFIN reconnects with the same ids
 * and with new ids, and household isolation.
 */

const OWNER_URL = "postgresql://dollas:dollas@127.0.0.1:5432/dollas";
const APP_URL = "postgresql://dollas_app:dollas@127.0.0.1:5432/dollas";
const FAKE_TOKEN = `v1.${"A".repeat(20)}.${"B".repeat(20)}`;
const NONE = { accounts: 0, transactions: 0 };

describe("reconnecting a bank does not duplicate charges (PEN-251)", () => {
  it("reattaches accounts and re-keys rows from the disconnected connection", async (t) => {
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
    process.env.BANK_CONNECTION_KEYS = `1:${Buffer.alloc(32, 7).toString("base64")}`;
    delete process.env.RESEND_API_KEY;

    const { withActor } = await import("../../db/actor");
    const { applyBankSync } = await import("./apply");
    const { disconnectBankConnection, syncMessage } = await import("./service");
    const { createRecurringItem } = await import("../recurring/service");
    const { deleteHouseholdTransaction, separateBankMatch } = await import("../activity/transactions");

    const stamp = randomBytes(4).toString("hex");
    const ids = { ada: randomUUID(), cy: randomUUID() };
    const houses: string[] = [];
    try {
      await owner`
        insert into "user" (id, name, email, email_verified) values
          (${ids.ada}, 'Ada', ${`ada-${stamp}@relink.test`}, true),
          (${ids.cy}, 'Cy', ${`cy-${stamp}@relink.test`}, true)
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
      const [groceries] = await owner<{ id: string }[]>`insert into category (household_id, name, kind, sort_order) values (${maple}, 'Groceries', 'expense', 1) returning id`;

      const connect = async (householdId: string, providerId: string) => {
        const [row] = await owner<{ id: string }[]>`
          insert into bank_connection (household_id, provider_id, label, encrypted_access_token, key_version)
          values (${householdId}, ${providerId}, ${`${providerId} bank`}, ${FAKE_TOKEN}, 1) returning id
        `;
        return row.id;
      };
      const sync = (
        actor: { userId: string; householdId: string },
        connectionId: string,
        providerId: string,
        accounts: ProviderAccount[],
        transactions: ProviderTransaction[],
      ) =>
        withActor(actor.userId, (tx) =>
          applyBankSync(tx, {
            householdId: actor.householdId,
            connectionId,
            providerId,
            since: "2026-09-01",
            accounts,
            transactions,
            ...(providerId === "plaid" ? { modified: [], removed: [], nextCursor: `c-${randomBytes(3).toString("hex")}` } : {}),
          }),
        );
      const account = (id: string, name: string, type: "checking" | "credit", mask?: string): ProviderAccount => ({
        providerAccountId: id,
        name,
        type,
        currency: "USD",
        balanceCents: 0,
        ...(mask ? { mask } : {}),
      });
      const charge = (prefix: string, accountId: string) => (id: string, occurredOn: string, amountCents: number, payee: string): ProviderTransaction => ({
        providerTransactionId: `${prefix}-${id}`,
        providerAccountId: accountId,
        occurredOn,
        payee,
        amountCents,
        pending: false,
      });
      // The same five charges as each item reports them (ids differ per item).
      const charges = (prefix: string, checking: string, card: string) => {
        const c = charge(prefix, checking);
        return [
          c("rent", "2026-09-01", -150_000, "RENT CO"),
          c("market", "2026-09-05", -4_200, "MARKET 042"),
          c("corner", "2026-09-08", -999, "CORNER STORE"),
          c("coffee", "2026-09-10", -450, "BLUE BOTTLE"),
          charge(prefix, card)("transit", "2026-09-06", -1_500, "TRANSIT"),
        ];
      };
      const ledgerCount = async (householdId: string) => (await owner<{ n: number }[]>`select count(*)::int as n from ledger_account where household_id = ${householdId}`)[0].n;
      const rowsIn = (householdId: string) =>
        owner<
          {
            id: string;
            account_id: string;
            payee: string;
            note: string | null;
            amount_cents: number;
            deleted_at: Date | null;
            bank_account_ref: string | null;
            bank_transaction_id: string | null;
            bank_matched_at: Date | null;
            created_by_user_id: string | null;
          }[]
        >`
          select id, account_id, payee, note, amount_cents, deleted_at, bank_account_ref, bank_transaction_id, bank_matched_at, created_by_user_id
          from "transaction" where household_id = ${householdId} order by occurred_on, payee, id
        `;

      // ---- Maple's first Plaid item. A member types one charge before the first sync. ----
      const [typedChecking] = await owner<{ id: string }[]>`
        insert into ledger_account (household_id, name, type, opening_balance_cents) values (${maple}, 'Plaid Checking', 'checking', 0) returning id
      `;
      const typed = await owner.begin(async (sql) => {
        const [row] = await sql<{ id: string }[]>`
          insert into "transaction" (household_id, account_id, occurred_on, payee, amount_cents) values (${maple}, ${typedChecking.id}, '2026-09-08', 'Corner store (typed)', -999) returning id
        `;
        await sql`insert into transaction_split (transaction_id, household_id, category_id, amount_cents) values (${row.id}, ${maple}, ${groceries.id}, -999)`;
        return row;
      });
      const itemA = await connect(maple, "plaid");
      const accountsA = [account("a-checking", "Plaid Checking", "checking", "1234"), account("a-card", "Plaid Card", "credit", "9876")];
      const first = await sync(ada, itemA, "plaid", accountsA, charges("a", "a-checking", "a-card"));
      assert.deepEqual(first, { accounts: 2, transactions: 4, matched: 1, updated: 0, removed: 0, reconnected: NONE });
      const [stored] = await owner<{ provider_account_name: string; provider_account_mask: string }[]>`
        select provider_account_name, provider_account_mask from bank_account where household_id = ${maple} and provider_account_id = 'a-checking'
      `;
      assert.deepEqual(stored, { provider_account_name: "Plaid Checking", provider_account_mask: "1234" }, "the provider's name and mask are stored");

      // Member edits: rename, note, and recategorize the market charge; delete the coffee; a recurring rent;
      // "Not the same charge" on the typed corner-store row; and rename the account.
      let rows = await rowsIn(maple);
      const byPayee = (payee: string) => rows.find((row) => row.payee === payee);
      const market = byPayee("MARKET 042");
      const coffee = byPayee("BLUE BOTTLE");
      const rent = byPayee("RENT CO");
      assert.ok(market && coffee && rent && byPayee("Corner store (typed)")?.bank_transaction_id === "a-corner");
      await owner`update "transaction" set payee = 'Groceries run', note = 'weekly shop' where id = ${market.id}`;
      await withActor(ada.userId, (tx) => tx.execute(`update transaction_split set category_id = '${groceries.id}' where transaction_id = '${market.id}'`));
      assert.ok((await deleteHouseholdTransaction(ada, coffee.id)).ok);
      const recurring = await createRecurringItem(ada, { name: "Rent", payeeMatch: "RENT CO", amountCents: -150_000, cadence: "monthly", anchorDate: "2026-09-01", dayOfMonth: 1 }, "2026-09-20");
      assert.ok(recurring.ok, JSON.stringify(recurring));
      const linksBefore = await owner<{ transaction_id: string }[]>`select transaction_id from recurring_link where recurring_item_id = ${recurring.value.id}`;
      assert.deepEqual(linksBefore.map((link) => link.transaction_id), [rent.id], "rent links to the recurring item");
      const separated = await separateBankMatch(ada, typed.id);
      assert.ok(separated.ok, JSON.stringify(separated));
      await owner`update ledger_account set name = 'Joint checking' where id = ${typedChecking.id}`;
      rows = await rowsIn(maple);
      const before = new Map(rows.map((row) => [row.id, row]));
      const bankCopy = rows.find((row) => row.payee === "CORNER STORE");
      assert.ok(bankCopy && bankCopy.bank_transaction_id === "a-corner" && byPayee("Corner store (typed)")?.bank_transaction_id === null);
      const ledgersBefore = await ledgerCount(maple);

      // Birch has its own disconnected item with the same mask and the same charges: never touched by Maple.
      const birchItem = await connect(birch, "plaid");
      await sync(cy, birchItem, "plaid", [account("a-checking", "Plaid Checking", "checking", "1234")], charges("a", "a-checking", "a-card").slice(0, 4));
      await owner`delete from bank_connection where id = ${birchItem}`;
      const birchBefore = await rowsIn(birch);

      // ---- Disconnect, then relink: Plaid makes a new item with new ids for everything. ----
      const off = await disconnectBankConnection(ada, itemA);
      assert.ok(off.ok, JSON.stringify(off));
      const [orphaned] = await owner<{ connection_id: string | null }[]>`select connection_id from bank_account where household_id = ${maple} and provider_account_id = 'a-checking'`;
      assert.equal(orphaned.connection_id, null, "a disconnect leaves the link inactive");
      const itemB = await connect(maple, "plaid");
      const accountsB = [account("b-checking", "Plaid Checking", "checking", "1234"), account("b-card", "Plaid Card", "credit", "9876")];
      const newCharge = charge("b", "b-checking")("hardware", "2026-09-20", -2_500, "HARDWARE STORE");
      const relinked = await sync(ada, itemB, "plaid", accountsB, [...charges("b", "b-checking", "b-card"), newCharge]);
      assert.deepEqual(relinked, { accounts: 2, transactions: 1, matched: 0, updated: 0, removed: 0, reconnected: { accounts: 2, transactions: 5 } });
      assert.match(syncMessage(relinked), /Picked up where the earlier connection left off: 5 transactions already in Dollas, not added again\./);
      assert.equal(await ledgerCount(maple), ledgersBefore, "no second checking or card account");
      const links = await owner<{ provider_account_id: string; connection_id: string; ledger_account_id: string }[]>`
        select provider_account_id, connection_id, ledger_account_id from bank_account where household_id = ${maple} order by provider_account_id
      `;
      assert.deepEqual(links.map((link) => [link.provider_account_id, link.connection_id]), [["b-card", itemB], ["b-checking", itemB]]);
      assert.equal(links.find((link) => link.provider_account_id === "b-checking")?.ledger_account_id, typedChecking.id, "reattached to the renamed account by mask");

      rows = await rowsIn(maple);
      assert.equal(rows.length, before.size + 1, "only the genuinely new charge was added");
      const after = (id: string) => rows.find((row) => row.id === id);
      assert.deepEqual(
        [after(market.id)?.payee, after(market.id)?.note, after(market.id)?.bank_transaction_id, after(market.id)?.bank_account_ref],
        ["Groceries run", "weekly shop", "b-market", "b-checking"],
        "member edits stay; only the identity moved",
      );
      const [split] = await owner<{ category_id: string }[]>`select category_id from transaction_split where transaction_id = ${market.id}`;
      assert.equal(split.category_id, groceries.id, "category kept");
      assert.ok(after(coffee.id)?.deleted_at, "the deleted charge stays deleted");
      assert.equal(after(coffee.id)?.bank_transaction_id, "b-coffee", "and its new id blocks it coming back");
      assert.equal(rows.filter((row) => row.amount_cents === -450).length, 1);
      const linksAfter = await owner<{ transaction_id: string }[]>`select transaction_id from recurring_link where recurring_item_id = ${recurring.value.id}`;
      assert.deepEqual(linksAfter.map((link) => link.transaction_id), [rent.id], "the recurring link stays on the same row");
      for (const row of rows) {
        const was = before.get(row.id);
        if (was) assert.equal(row.created_by_user_id, was.created_by_user_id, "attribution unchanged");
      }
      assert.equal(after(bankCopy.id)?.bank_transaction_id, "b-corner", "the separated bank copy is re-keyed");
      assert.equal(after(typed.id)?.bank_transaction_id, null, "the member's separated row stays unlinked");
      assert.equal(rows.filter((row) => row.amount_cents === -999).length, 2, "a separated pair stays two rows");
      assert.equal(rows.find((row) => row.payee === "HARDWARE STORE")?.bank_transaction_id, "b-hardware");
      assert.deepEqual(await rowsIn(birch), birchBefore, "another household's rows are untouched");

      // ---- Re-running is a no-op. A same-item sync (Plaid update mode keeps the item and its ids) is the same. ----
      assert.deepEqual(await sync(ada, itemB, "plaid", accountsB, [...charges("b", "b-checking", "b-card"), newCharge]), {
        accounts: 2,
        transactions: 0,
        matched: 0,
        updated: 0,
        removed: 0,
        reconnected: NONE,
      });
      assert.deepEqual(await rowsIn(maple), rows);

      // ---- Active-item guard: a second live item for the same bank never takes item B's rows or account. ----
      const itemC = await connect(maple, "plaid");
      const fromC = await sync(ada, itemC, "plaid", [account("c-checking", "Plaid Checking", "checking", "1234")], [charge("c", "c-checking")("market", "2026-09-05", -4_200, "MARKET 042")]);
      assert.deepEqual(fromC.reconnected, NONE);
      assert.equal(fromC.transactions, 1, "item C's charge is its own row");
      const stillB = await rowsIn(maple);
      assert.equal(stillB.find((row) => row.id === market.id)?.bank_transaction_id, "b-market", "item B's row keeps its identity");
      assert.equal(await ledgerCount(maple), ledgersBefore + 1, "item C gets its own account, as before PEN-251");
      const [bLink] = await owner<{ connection_id: string }[]>`select connection_id from bank_account where household_id = ${maple} and provider_account_id = 'b-checking'`;
      assert.equal(bLink.connection_id, itemB);

      // ---- RLS: another household's member cannot run Maple's relink. ----
      await assert.rejects(
        sync(cy, itemB, "plaid", accountsB, charges("z", "b-checking", "b-card")).then(() => undefined),
        "Cy cannot sync into Maple",
      );
      // Cy syncing Birch's own relink stays inside Birch.
      const birchB = await connect(birch, "plaid");
      const birchRelink = await sync(cy, birchB, "plaid", [account("bb-checking", "Plaid Checking", "checking", "1234")], charges("bb", "bb-checking", "bb-card").slice(0, 4));
      assert.deepEqual(birchRelink.reconnected, { accounts: 1, transactions: 4 });
      assert.deepEqual((await rowsIn(maple)).length, stillB.length, "Maple unchanged by Birch's relink");

      // ---- SimpleFIN: a reconnect that keeps ids is a no-op; one that changes them re-keys. ----
      const sf = (prefix: string, accountId: string) => [
        charge(prefix, accountId)("pay", "2026-09-15", 300_000, "PAYROLL"),
        charge(prefix, accountId)("fuel", "2026-09-16", -6_000, "FUEL"),
      ];
      const sf1 = await connect(maple, "simplefin");
      const union = (id: string) => [account(id, "Credit Union", "checking")];
      assert.equal((await sync(ada, sf1, "simplefin", union("sf-1"), sf("s1", "sf-1"))).transactions, 2);
      await owner`delete from bank_connection where id = ${sf1}`;
      const sf2 = await connect(maple, "simplefin");
      assert.deepEqual(await sync(ada, sf2, "simplefin", union("sf-1"), sf("s1", "sf-1")), { accounts: 1, transactions: 0, matched: 0, updated: 0, removed: 0, reconnected: NONE });
      await owner`delete from bank_connection where id = ${sf2}`;
      const sf3 = await connect(maple, "simplefin");
      const changed = await sync(ada, sf3, "simplefin", union("sf-9"), sf("s9", "sf-9"));
      assert.deepEqual(changed, { accounts: 1, transactions: 0, matched: 0, updated: 0, removed: 0, reconnected: { accounts: 1, transactions: 2 } });
      const fuel = await owner<{ n: number }[]>`select count(*)::int as n from "transaction" where household_id = ${maple} and payee = 'FUEL'`;
      assert.equal(fuel[0].n, 1);
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
