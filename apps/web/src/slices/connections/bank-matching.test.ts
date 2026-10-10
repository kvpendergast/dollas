import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import type { ColumnMapping, ProviderAccount, ProviderTransaction } from "@dollas/domain";
import postgres from "postgres";
import { assertAppRoleSubjectToRls, migrateWithUrl } from "../../db/apply-migrations";
import { initTelemetry } from "../../lib/telemetry";

/**
 * PEN-203 against a real database, as members through RLS: re-sync is a
 * no-op (SimpleFIN over a loopback bridge, Plaid with adapter-shaped pages),
 * CSV then bank is one transaction, bank then CSV is one (preview duplicate),
 * pending to posted, Plaid modified and removed, soft-deleted stays deleted,
 * undo of a linked import, "Not the same charge", the 0026 backfill, and
 * household isolation. The ambiguity rule is unit-tested in the domain.
 */

const OWNER_URL = "postgresql://dollas:dollas@127.0.0.1:5432/dollas";
const APP_URL = "postgresql://dollas_app:dollas@127.0.0.1:5432/dollas";

type BridgeTxn = { id: string; posted: string; amount: string; description: string; transacted?: string };

function unix(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000);
}

/** Loopback SimpleFIN bridge whose transactions the test can change between syncs. */
async function simpleFinBridge(state: { transactions: BridgeTxn[] }): Promise<{ server: Server; port: number }> {
  let port = 0;
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url?.startsWith("/simplefin/claim/")) {
      response.end(`http://agent:pw${randomBytes(6).toString("hex")}@127.0.0.1:${port}/simplefin`);
      return;
    }
    if (request.method === "GET" && request.url?.startsWith("/simplefin/accounts")) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          errors: [],
          accounts: [
            {
              id: "act-bridge",
              name: "Bridge Checking",
              currency: "USD",
              balance: "1000.00",
              transactions: state.transactions.map((row) => ({
                id: row.id,
                posted: unix(row.posted),
                amount: row.amount,
                description: row.description,
                pending: false,
                ...(row.transacted ? { transacted_at: unix(row.transacted) } : {}),
              })),
            },
          ],
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  return { server, port };
}

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

describe("idempotent bank sync and cross-source matching (PEN-203)", () => {
  it("keeps one transaction per charge across bank sync, CSV import, edits, deletes, and undo", async (t) => {
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
    delete process.env.RESEND_FROM;

    const { withActor } = await import("../../db/actor");
    const { applyBankSync } = await import("./apply");
    const { linkSimpleFinConnection, syncBankConnection, syncMessage } = await import("./service");
    const { commitCsvImport, previewCsvImport, undoCsvImport } = await import("../activity/csv-import-service");
    const { deleteHouseholdTransaction, listHouseholdTransactions, separateBankMatch } = await import("../activity/transactions");

    const stamp = randomBytes(4).toString("hex");
    const ids = { ada: randomUUID(), cy: randomUUID() };
    const houses: string[] = [];
    const bridgeState: { transactions: BridgeTxn[] } = { transactions: [] };
    const bridge = await simpleFinBridge(bridgeState);
    const token = (tag: string) => Buffer.from(`http://127.0.0.1:${bridge.port}/simplefin/claim/${tag}`).toString("base64");

    try {
      await owner`
        insert into "user" (id, name, email, email_verified) values
          (${ids.ada}, 'Ada', ${`ada-${stamp}@match.test`}, true),
          (${ids.cy}, 'Cy', ${`cy-${stamp}@match.test`}, true)
      `;
      const created = await owner<{ id: string; name: string }[]>`
        insert into household (name, created_by) values (${`Maple ${stamp}`}, ${ids.ada}), (${`Birch ${stamp}`}, ${ids.cy})
        returning id, name
      `;
      const maple = created.find((row) => row.name.startsWith("Maple"))?.id ?? "";
      const birch = created.find((row) => row.name.startsWith("Birch"))?.id ?? "";
      houses.push(maple, birch);
      await owner`
        insert into household_member (household_id, user_id, role) values (${maple}, ${ids.ada}, 'owner'), (${birch}, ${ids.cy}, 'owner')
      `;
      const ada = { userId: ids.ada, householdId: maple };
      const cy = { userId: ids.cy, householdId: birch };
      const [mapleChecking] = await owner<{ id: string }[]>`
        insert into ledger_account (household_id, name, type, opening_balance_cents) values (${maple}, 'Bridge Checking', 'checking', 0) returning id
      `;
      const [birchChecking] = await owner<{ id: string }[]>`
        insert into ledger_account (household_id, name, type, opening_balance_cents) values (${birch}, 'Bridge Checking', 'checking', 0) returning id
      `;
      const [streamingCategory] = await owner<{ id: string }[]>`
        insert into category (household_id, name, kind, sort_order) values (${maple}, 'Subscriptions', 'expense', 1) returning id
      `;
      const [birchCategory] = await owner<{ id: string }[]>`
        insert into category (household_id, name, kind, sort_order) values (${birch}, 'Home', 'expense', 1) returning id
      `;
      /** A transaction plus its balanced split, as the deferred split check requires. */
      const insertRow = (row: { householdId: string; accountId: string; occurredOn: string; payee: string; amountCents: number; categoryId: string; importFingerprint?: string }) =>
        owner.begin(async (sql) => {
          const [inserted] = await sql<{ id: string }[]>`
            insert into "transaction" (household_id, account_id, occurred_on, payee, amount_cents, import_fingerprint)
            values (${row.householdId}, ${row.accountId}, ${row.occurredOn}, ${row.payee}, ${row.amountCents}, ${row.importFingerprint ?? null}) returning id
          `;
          await sql`insert into transaction_split (transaction_id, household_id, category_id, amount_cents) values (${inserted.id}, ${row.householdId}, ${row.categoryId}, ${row.amountCents})`;
          return inserted;
        });
      const rowsOn = (accountId: string) => owner<
        {
          id: string;
          payee: string;
          occurred_on: string;
          amount_cents: number;
          note: string | null;
          deleted_at: Date | null;
          import_batch_id: string | null;
          import_fingerprint: string | null;
          bank_transaction_id: string | null;
          bank_matched_at: Date | null;
        }[]
      >`
        select id, payee, occurred_on::text, amount_cents, note, deleted_at, import_batch_id, import_fingerprint, bank_transaction_id, bank_matched_at
        from "transaction" where account_id = ${accountId} order by occurred_on, payee
      `;

      // ---- CSV first, then the bank (SimpleFIN). ----
      const firstCsv = ["date,payee,amount", "2026-09-14,Streaming Co,-9.99", "2026-09-10,Coffee,-4.50", "2026-09-01,Rent,-1200.00"].join("\n");
      const imported = await commitCsvImport(ada, { csv: firstCsv, mapping: mappingFor(mapleChecking.id) });
      assert.ok(imported.ok && imported.value.added === 3 && imported.value.batchId, JSON.stringify(imported));
      const firstBatch = imported.value.batchId;
      const csvRows = await rowsOn(mapleChecking.id);
      const streaming = csvRows.find((row) => row.payee === "Streaming Co");
      const coffee = csvRows.find((row) => row.payee === "Coffee");
      assert.ok(streaming && coffee);
      // The member renames, notes, and recategorizes the streaming row, and deletes the coffee row.
      await owner`update "transaction" set payee = 'Netflix', note = 'family plan' where id = ${streaming.id}`;
      await owner`update transaction_split set category_id = ${streamingCategory.id} where transaction_id = ${streaming.id}`;
      const deleted = await deleteHouseholdTransaction(ada, coffee.id);
      assert.ok(deleted.ok);

      bridgeState.transactions = [
        { id: "txn-stream", posted: "2026-09-15", amount: "-9.99", description: "STREAMING SVC" },
        { id: "txn-coffee", posted: "2026-09-11", amount: "-4.50", description: "BLUE BOTTLE" },
        { id: "txn-hardware", posted: "2026-09-20", amount: "-25.00", description: "HARDWARE STORE" },
      ];
      const linked = await linkSimpleFinConnection(ada, { token: token("maple"), label: "Credit union", sinceRaw: "2026-09-01" });
      assert.ok(linked.ok, JSON.stringify(linked));
      const mapleConnection = linked.value.connectionId;
      const first = await syncBankConnection(ada, mapleConnection);
      assert.ok(first.ok, JSON.stringify(first));
      assert.deepEqual(first.value, { accounts: 1, transactions: 1, matched: 2, updated: 0, removed: 0 });
      assert.match(syncMessage(first.value), /matched 2 already in your books/);

      let rows = await rowsOn(mapleChecking.id);
      assert.equal(rows.length, 4, "streaming, coffee (deleted), rent, hardware: no bank copies of CSV rows");
      const linkedStreaming = rows.find((row) => row.id === streaming.id);
      assert.equal(linkedStreaming?.payee, "Netflix", "member's payee rename stays");
      assert.equal(linkedStreaming?.note, "family plan", "member's note stays");
      assert.equal(linkedStreaming?.occurred_on, "2026-09-14", "member's date stays");
      assert.equal(linkedStreaming?.bank_transaction_id, "txn-stream");
      assert.ok(linkedStreaming?.bank_matched_at);
      const [split] = await owner<{ category_id: string }[]>`select category_id from transaction_split where transaction_id = ${streaming.id}`;
      assert.equal(split?.category_id, streamingCategory.id, "member's category stays");
      const linkedCoffee = rows.find((row) => row.id === coffee.id);
      assert.ok(linkedCoffee?.deleted_at, "soft-deleted row stays deleted");
      assert.equal(linkedCoffee?.bank_transaction_id, "txn-coffee", "and now blocks the bank row from coming back");
      assert.equal(rows.filter((row) => row.payee === "BLUE BOTTLE").length, 0, "no new row for the deleted charge");
      assert.equal(rows.find((row) => row.payee === "HARDWARE STORE")?.bank_matched_at, null, "sync-created row is not 'matched'");

      // ---- Re-running sync is a no-op. ----
      const again = await syncBankConnection(ada, mapleConnection);
      assert.ok(again.ok);
      assert.deepEqual(again.value, { accounts: 1, transactions: 0, matched: 0, updated: 0, removed: 0 });
      assert.equal(syncMessage(again.value), "Updated 1 account. No new transactions.");
      assert.equal((await rowsOn(mapleChecking.id)).length, 4);

      // The list shows bank state to the UI and MCP.
      const listed = await listHouseholdTransactions(ada, { limit: 50, offset: 0 });
      assert.ok(listed.ok);
      const shownStreaming = listed.value.items.find((item) => item.id === streaming.id);
      assert.deepEqual([shownStreaming?.bankBacked, shownStreaming?.bankMatched], [true, true]);

      // ---- Bank first, then CSV: the bank's charge shows as a duplicate in the preview. ----
      const secondCsv = ["date,payee,amount", "2026-09-19,Hardware,-25.00", "2026-09-21,Gift,50.00"].join("\n");
      const preview = await previewCsvImport(ada, { csv: secondCsv, mapping: mappingFor(mapleChecking.id) });
      assert.ok(preview.ok && preview.value.kind === "preview", JSON.stringify(preview));
      assert.equal(preview.value.preview.duplicateCount, 1);
      assert.equal(preview.value.preview.readyCount, 1);
      assert.deepEqual(
        preview.value.preview.rows.map((row) => [row.status, row.duplicateOf]),
        [["duplicate", "bank"], ["ready", null]],
      );
      const secondImport = await commitCsvImport(ada, { csv: secondCsv, mapping: mappingFor(mapleChecking.id) });
      assert.ok(secondImport.ok && secondImport.value.added === 1 && secondImport.value.duplicateCount === 1);
      rows = await rowsOn(mapleChecking.id);
      assert.equal(rows.filter((row) => row.amount_cents === -2500).length, 1, "one hardware charge");
      // The first file again: every row is already in the books.
      const replayPreview = await previewCsvImport(ada, { csv: firstCsv, mapping: mappingFor(mapleChecking.id) });
      assert.ok(replayPreview.ok && replayPreview.value.kind === "preview");
      assert.equal(replayPreview.value.preview.duplicateCount, 3);

      // ---- Undo the first import after the bank linked two of its rows. ----
      const undone = await undoCsvImport(ada, firstBatch);
      assert.ok(undone.ok, JSON.stringify(undone));
      assert.deepEqual([undone.value.removed, undone.value.kept], [1, 2]);
      assert.match(undone.value.message, /Kept 2 transactions your bank also reported/);
      rows = await rowsOn(mapleChecking.id);
      assert.equal(rows.some((row) => row.payee === "Rent"), false, "the unbacked row is removed");
      const keptStreaming = rows.find((row) => row.id === streaming.id);
      assert.equal(keptStreaming?.import_batch_id, null, "kept row is detached from the batch");
      assert.ok(keptStreaming?.import_fingerprint, "and keeps its fingerprint, so the file stays a duplicate");
      assert.ok(rows.find((row) => row.id === coffee.id)?.deleted_at, "kept deleted row is still deleted");
      const afterUndo = await syncBankConnection(ada, mapleConnection);
      assert.ok(afterUndo.ok);
      assert.equal(afterUndo.value.transactions + afterUndo.value.matched, 0, "sync after undo adds nothing");

      // ---- "Not the same charge": split the wrong match. ----
      const separated = await separateBankMatch(ada, streaming.id);
      assert.ok(separated.ok, JSON.stringify(separated));
      rows = await rowsOn(mapleChecking.id);
      const original = rows.find((row) => row.id === streaming.id);
      const bankCopy = rows.find((row) => row.id === separated.value.bankCopyId);
      assert.deepEqual([original?.payee, original?.bank_transaction_id, original?.bank_matched_at], ["Netflix", null, null]);
      assert.deepEqual([bankCopy?.payee, bankCopy?.occurred_on, bankCopy?.amount_cents, bankCopy?.bank_transaction_id], [
        "STREAMING SVC",
        "2026-09-15",
        -999,
        "txn-stream",
      ]);
      const [copySplit] = await owner<{ amount_cents: number }[]>`select amount_cents from transaction_split where transaction_id = ${bankCopy?.id ?? ""}`;
      assert.equal(copySplit?.amount_cents, -999, "the bank copy has a balanced category split");
      const notMatched = await separateBankMatch(ada, bankCopy?.id ?? "");
      assert.equal(notMatched.ok, false, "a sync-created row cannot be separated");
      const afterSeparate = await syncBankConnection(ada, mapleConnection);
      assert.ok(afterSeparate.ok);
      assert.equal(afterSeparate.value.transactions + afterSeparate.value.matched, 0, "sync does not re-link them");

      // ---- Household isolation (RLS). ----
      await insertRow({ householdId: birch, accountId: birchChecking.id, occurredOn: "2026-09-20", payee: "Birch hardware", amountCents: -2500, categoryId: birchCategory.id });
      const birchLinked = await linkSimpleFinConnection(cy, { token: token("birch"), label: "Birch bank", sinceRaw: "2026-09-01" });
      assert.ok(birchLinked.ok);
      const birchSync = await syncBankConnection(cy, birchLinked.value.connectionId);
      assert.ok(birchSync.ok, JSON.stringify(birchSync));
      assert.equal(birchSync.value.matched, 1, "Birch matches only its own row");
      const mapleHardware = await owner<{ household_id: string }[]>`
        select household_id from "transaction" where bank_transaction_id = 'txn-hardware' order by household_id
      `;
      assert.equal(mapleHardware.length, 2, "the same provider id is a separate identity per household");
      const mapleBefore = await owner<{ n: number }[]>`select count(*)::int as n from "transaction" where household_id = ${maple}`;
      await assert.rejects(
        withActor(cy.userId, (tx) =>
          applyBankSync(tx, {
            householdId: maple,
            connectionId: mapleConnection,
            providerId: "simplefin",
            since: "2026-09-01",
            accounts: [{ providerAccountId: "act-bridge", name: "Bridge Checking", type: "checking", currency: "USD", balanceCents: 0 }],
            transactions: [
              { providerTransactionId: "intruder", providerAccountId: "act-bridge", occurredOn: "2026-09-14", payee: "x", amountCents: -999, pending: false },
            ],
          }),
        ),
        "a member of another household cannot sync into Maple",
      );
      const mapleAfter = await owner<{ n: number }[]>`select count(*)::int as n from "transaction" where household_id = ${maple}`;
      assert.equal(mapleAfter[0]?.n, mapleBefore[0]?.n);

      // ---- Plaid: pending to posted, replay, modified, removed, deleted stays deleted. ----
      const [plaidChecking] = await owner<{ id: string }[]>`
        insert into ledger_account (household_id, name, type, opening_balance_cents) values (${maple}, 'Plaid Checking', 'checking', 0) returning id
      `;
      const market = await insertRow({ householdId: maple, accountId: plaidChecking.id, occurredOn: "2026-09-05", payee: "Market (typed in)", amountCents: -4200, categoryId: streamingCategory.id });
      const [plaidConnection] = await owner<{ id: string }[]>`
        insert into bank_connection (household_id, provider_id, label, encrypted_access_token, key_version)
        values (${maple}, 'plaid', 'Plaid bank', ${`v1.${"A".repeat(20)}.${"B".repeat(20)}`}, 1) returning id
      `;
      const plaidAccount: ProviderAccount = { providerAccountId: "plaid-checking", name: "Plaid Checking", type: "checking", currency: "USD", balanceCents: 0 };
      const plaidTxn = (id: string, occurredOn: string, amountCents: number, extra: Partial<ProviderTransaction> = {}): ProviderTransaction => ({
        providerTransactionId: id,
        providerAccountId: "plaid-checking",
        occurredOn,
        payee: "MARKET 042",
        amountCents,
        pending: false,
        ...extra,
      });
      const plaidSync = (page: { added?: ProviderTransaction[]; modified?: ProviderTransaction[]; removed?: string[] }) =>
        withActor(ada.userId, (tx) =>
          applyBankSync(tx, {
            householdId: maple,
            connectionId: plaidConnection.id,
            providerId: "plaid",
            since: "2026-09-01",
            accounts: [plaidAccount],
            transactions: page.added ?? [],
            modified: page.modified ?? [],
            removed: page.removed ?? [],
            nextCursor: `cursor-${randomBytes(3).toString("hex")}`,
          }),
        );
      const page1 = { added: [plaidTxn("pending-1", "2026-09-04", -4200, { pending: true }), plaidTxn("bus-1", "2026-09-06", -1500, { payee: "TRANSIT" })] };
      assert.deepEqual(await plaidSync(page1), { accounts: 1, transactions: 1, matched: 0, updated: 0, removed: 0 }, "pending is not booked");
      const page2 = {
        added: [plaidTxn("posted-1", "2026-09-08", -4200, { authorizedOn: "2026-09-04", pendingTransactionId: "pending-1" })],
        removed: ["pending-1"],
      };
      assert.deepEqual(await plaidSync(page2), { accounts: 1, transactions: 0, matched: 1, updated: 0, removed: 0 }, "posted row links to the typed-in row");
      assert.deepEqual(await plaidSync(page1), { accounts: 1, transactions: 0, matched: 0, updated: 0, removed: 0 }, "replaying page 1 is a no-op");
      assert.deepEqual(await plaidSync(page2), { accounts: 1, transactions: 0, matched: 0, updated: 0, removed: 0 }, "replaying page 2 is a no-op");
      let plaidRows = await rowsOn(plaidChecking.id);
      assert.equal(plaidRows.length, 2);
      assert.deepEqual(
        plaidRows.map((row) => [row.payee, row.bank_transaction_id]),
        [["Market (typed in)", "posted-1"], ["TRANSIT", "bus-1"]],
      );

      const modified = await plaidSync({ modified: [plaidTxn("posted-1", "2026-09-08", -4500, { payee: "MARKET 042 TIP" })] });
      assert.equal(modified.updated, 1);
      plaidRows = await rowsOn(plaidChecking.id);
      const marketRow = plaidRows.find((row) => row.id === market.id);
      assert.deepEqual([marketRow?.payee, marketRow?.occurred_on, marketRow?.amount_cents], ["Market (typed in)", "2026-09-05", -4500]);
      const [marketSplit] = await owner<{ amount_cents: number }[]>`select amount_cents from transaction_split where transaction_id = ${market.id}`;
      assert.equal(marketSplit?.amount_cents, -4500, "the single split follows the bank's new amount");

      const removed = await plaidSync({ removed: ["bus-1", "posted-1"] });
      assert.equal(removed.removed, 1, "the sync-created row is hidden");
      plaidRows = await rowsOn(plaidChecking.id);
      assert.ok(plaidRows.find((row) => row.payee === "TRANSIT")?.deleted_at);
      const unlinked = plaidRows.find((row) => row.id === market.id);
      assert.deepEqual([unlinked?.deleted_at, unlinked?.bank_transaction_id], [null, null], "the matched row is unlinked and kept");
      assert.deepEqual(
        await plaidSync({ added: [plaidTxn("bus-1", "2026-09-06", -1500, { payee: "TRANSIT" })] }),
        { accounts: 1, transactions: 0, matched: 0, updated: 0, removed: 0 },
        "a removed (deleted) charge listed again does not come back",
      );

      // ---- 0026 backfill: a pre-PEN-203 `bank:` fingerprint moves to the identity columns. ----
      const legacy = await insertRow({ householdId: maple, accountId: plaidChecking.id, occurredOn: "2026-09-02", payee: "Legacy", amountCents: -100, categoryId: streamingCategory.id, importFingerprint: "bank:plaid:old%2Fid%20%C3%A9" });
      const unlinkedLegacy = await insertRow({ householdId: maple, accountId: mapleChecking.id, occurredOn: "2026-09-02", payee: "Legacy elsewhere", amountCents: -100, categoryId: streamingCategory.id, importFingerprint: "bank:plaid:orphan" });
      await owner.unsafe(readFileSync(new URL("../../../drizzle/0026_bank_identity_backfill.sql", import.meta.url), "utf8"));
      const [moved] = await owner<{ import_fingerprint: string | null; bank_provider_id: string; bank_account_ref: string; bank_transaction_id: string }[]>`
        select import_fingerprint, bank_provider_id, bank_account_ref, bank_transaction_id from "transaction" where id = ${legacy.id}
      `;
      assert.deepEqual(moved, { import_fingerprint: null, bank_provider_id: "plaid", bank_account_ref: "plaid-checking", bank_transaction_id: "old/id é" });
      const [orphan] = await owner<{ import_fingerprint: string | null }[]>`select import_fingerprint from "transaction" where id = ${unlinkedLegacy.id}`;
      assert.equal(orphan?.import_fingerprint, "bank:plaid:orphan", "a row not tied to a Plaid account keeps its legacy fingerprint");
      assert.deepEqual(
        await plaidSync({ added: [plaidTxn("old/id é", "2026-09-02", -100), plaidTxn("orphan", "2026-09-02", -100)] }),
        { accounts: 1, transactions: 0, matched: 0, updated: 0, removed: 0 },
        "backfilled and legacy identities are both known",
      );
    } finally {
      try {
        for (const house of houses) await owner`delete from household where id = ${house}`;
        for (const id of Object.values(ids)) await owner`delete from "user" where id = ${id}`;
      } finally {
        await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
        await owner.end({ timeout: 1 });
        const { closeDb } = await import("../../db/client");
        await closeDb();
      }
    }
  });
});
