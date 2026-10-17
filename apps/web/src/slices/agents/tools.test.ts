import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentGrant } from "@dollas/domain";
import postgres from "postgres";
import { assertAppRoleSubjectToRls, migrateWithUrl } from "../../db/apply-migrations";
import { initTelemetry } from "../../lib/telemetry";

/**
 * Every MCP tool against a real database, as the member through RLS:
 * happy path per tool, scope enforcement, confirm guards, and household
 * isolation. The HTTP and OAuth layers are covered in mcp-oauth.test.ts.
 */

const OWNER_URL = "postgresql://dollas:dollas@127.0.0.1:5432/dollas";
const APP_URL = "postgresql://dollas_app:dollas@127.0.0.1:5432/dollas";

type Called = { isError: boolean; data: Record<string, unknown>; text: string };

function isoToUnix(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000);
}

/** A loopback SimpleFIN bridge so sync runs the real provider code. */
async function simpleFinBridge(): Promise<{ server: Server; port: number; secret: string }> {
  const secret = `pw${randomBytes(8).toString("hex")}`;
  let port = 0;
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url?.startsWith("/simplefin/claim/")) {
      response.end(`http://agent:${secret}@127.0.0.1:${port}/simplefin`);
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
              balance: "250.00",
              transactions: [{ id: "txn-1", posted: isoToUnix("2026-09-15"), amount: "-9.99", description: "Streaming", pending: false }],
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
  return { server, port, secret };
}

describe("Dollas MCP tools", () => {
  it("covers every tool: happy path, scope, confirm guards, and RLS isolation", async (t) => {
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

    const { createDollasMcpServer, runTool } = await import("@dollas/mcp");
    const { DOLLAS_TOOLS } = await import("./tools");
    const { loadBooksForMember } = await import("../access/member");
    const { linkSimpleFinConnection } = await import("../connections/service");

    const stamp = randomBytes(4).toString("hex");
    const ids = { ada: randomUUID(), bob: randomUUID(), cy: randomUUID(), dee: randomUUID() };
    const houses: string[] = [];
    const covered = new Set<string>();
    const bridge = await simpleFinBridge();

    async function clientFor(userId: string, householdId: string, access: "read" | "write") {
      const books = await loadBooksForMember(userId, householdId);
      assert.ok(books, "member can open the household");
      const grant: AgentGrant = {
        userId,
        householdId,
        clientId: "test-agent",
        access,
        scopes: access === "write" ? ["dollas:read", "dollas:write"] : ["dollas:read"],
      };
      const server = createDollasMcpServer(grant, DOLLAS_TOOLS, { books, grant });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "tools-test", version: "1.0.0" });
      await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
      const call = async (name: string, args: Record<string, unknown> = {}): Promise<Called> => {
        const result = await client.callTool({ name, arguments: args });
        const parts = (result.content as Array<{ text: string }>).map((part) => part.text);
        const called = { isError: result.isError === true, data: (result.structuredContent ?? {}) as Record<string, unknown>, text: parts.join("\n") };
        if (!called.isError) covered.add(name);
        return called;
      };
      const ok = async (name: string, args: Record<string, unknown> = {}) => {
        const called = await call(name, args);
        assert.equal(called.isError, false, `${name} failed: ${called.text}`);
        assert.ok(called.text.length > 0, `${name} has a summary`);
        return called.data;
      };
      return { call, ok, books, grant, close: () => client.close() };
    }

    let failure: unknown;
    try {
      await owner`
        insert into "user" (id, name, email, email_verified) values
          (${ids.ada}, 'Ada', ${`ada-${stamp}@tools.test`}, true),
          (${ids.bob}, 'Bob', ${`bob-${stamp}@tools.test`}, true),
          (${ids.cy}, 'Cy', ${`cy-${stamp}@tools.test`}, true),
          (${ids.dee}, 'Dee', ${`dee-${stamp}@tools.test`}, true)
      `;
      const created = await owner<{ id: string; name: string }[]>`
        insert into household (name, created_by) values
          (${`Maple ${stamp}`}, ${ids.ada}), (${`Birch ${stamp}`}, ${ids.cy}), (${`Doomed ${stamp}`}, ${ids.dee})
        returning id, name
      `;
      const maple = created.find((row) => row.name.startsWith("Maple"))?.id ?? "";
      const birch = created.find((row) => row.name.startsWith("Birch"))?.id ?? "";
      const doomed = created.find((row) => row.name.startsWith("Doomed"))?.id ?? "";
      houses.push(maple, birch, doomed);
      await owner`
        insert into household_member (household_id, user_id, role) values
          (${maple}, ${ids.ada}, 'owner'), (${maple}, ${ids.bob}, 'member'),
          (${birch}, ${ids.cy}, 'owner'), (${doomed}, ${ids.dee}, 'owner')
      `;
      const [birchAccount] = await owner<{ id: string }[]>`
        insert into ledger_account (household_id, name, type, opening_balance_cents) values (${birch}, 'Birch Secret Savings', 'savings', 999900) returning id
      `;

      const ada = await clientFor(ids.ada, maple, "write");

      // Who am I.
      const who = await ada.ok("whoami");
      assert.equal((who.member as { role: string }).role, "owner");
      assert.equal(who.access, "write");

      // Categories and groups.
      const everyday = (await ada.ok("create_category_group", { name: "Everyday" })).id as string;
      const spare = (await ada.ok("create_category_group", { name: "Spare" })).id as string;
      const groceries = (await ada.ok("create_category", { name: "Groceries", kind: "expense", group_id: everyday })).id as string;
      const dining = (await ada.ok("create_category", { name: "Dining", kind: "expense", group_id: everyday })).id as string;
      const fun = (await ada.ok("create_category", { name: "Fun", kind: "expense", group_id: everyday })).id as string;
      await ada.ok("create_category", { name: "Paycheck", kind: "income", group_id: everyday });
      await ada.ok("rename_category_group", { group_id: everyday, name: "Daily" });
      await ada.ok("move_category", { category_id: fun, group_id: spare });
      await ada.ok("reorder_category_group", { group_id: spare, direction: "up" });
      await ada.ok("reorder_category", { category_id: dining, direction: "up" });
      await ada.ok("set_budget", { category_id: fun, amount_cents: 2500 });
      const kindRefused = await ada.call("change_category_kind", { category_id: fun, kind: "income" });
      assert.equal(kindRefused.isError, true, "changing a budgeted category's kind needs confirm_budget_removal");
      const kindChanged = await ada.ok("change_category_kind", { category_id: fun, kind: "income", confirm_budget_removal: true });
      assert.equal(kindChanged.removed_budgets, true);
      await ada.ok("remove_category_group", { group_id: spare, ungrouped: true });
      const catalog = await ada.ok("list_categories");
      const daily = (catalog.groups as Array<{ name: string; categories: Array<{ name: string }> }>).find((group) => group.name === "Daily");
      assert.deepEqual(daily?.categories.map((row) => row.name), ["Dining", "Groceries", "Paycheck"]);
      assert.deepEqual((catalog.ungrouped as Array<{ name: string }>).map((row) => row.name), ["Fun"]);

      // Accounts.
      const checking = (await ada.ok("create_account", { name: "Checking", type: "checking", opening_balance_cents: 100000 })).id as string;
      const spareAccount = (await ada.ok("create_account", { name: "Jar", type: "cash" })).id as string;
      const updated = await ada.ok("update_account", { account_id: spareAccount, name: "Coin Jar", opening_balance_cents: 512 });
      assert.equal(updated.opening_balance_cents, 512);
      await ada.ok("archive_account", { account_id: spareAccount });
      const activeOnly = await ada.ok("list_accounts");
      assert.deepEqual((activeOnly.items as Array<{ name: string }>).map((row) => row.name), ["Checking"]);
      await ada.ok("unarchive_account", { account_id: spareAccount });
      const unconfirmed = await ada.call("delete_account", { account_id: spareAccount });
      assert.equal(unconfirmed.isError, true, "delete_account needs confirm");
      assert.equal((await owner`select 1 from ledger_account where id = ${spareAccount}`).length, 1);
      await ada.ok("delete_account", { account_id: spareAccount, confirm: true });
      assert.equal((await owner`select 1 from ledger_account where id = ${spareAccount}`).length, 0);

      // Transactions: create, edit, categorize, split, delete, restore.
      const t1 = (
        await ada.ok("create_transaction", {
          account_id: checking,
          occurred_on: "2026-09-20",
          payee: "Corner Market",
          amount_cents: -4200,
          category_id: groceries,
        })
      ).id as string;
      const t2 = (
        await ada.ok("create_transaction", {
          account_id: checking,
          occurred_on: "2026-09-21",
          payee: "Diner and Deli",
          amount_cents: -3000,
          splits: [
            { category_id: groceries, amount_cents: -2000 },
            { category_id: dining, amount_cents: -1000 },
          ],
        })
      ).id as string;
      assert.equal((await ada.call("create_transaction", { account_id: checking, occurred_on: "2026-09-21", payee: "X", amount_cents: -1 })).isError, true);
      const unbalanced = await ada.call("create_transaction", {
        account_id: checking,
        occurred_on: "2026-09-21",
        payee: "X",
        amount_cents: -3000,
        splits: [
          { category_id: groceries, amount_cents: -100 },
          { category_id: dining, amount_cents: -100 },
        ],
      });
      assert.equal(unbalanced.isError, true);
      assert.match(unbalanced.text, /add up/);
      await ada.ok("update_transaction", { transaction_id: t1, payee: "Corner Market Co" });
      const categorized = await ada.ok("categorize_transaction", { transaction_id: t2, category_id: dining });
      assert.deepEqual(categorized.splits, [{ category_id: dining, category_name: "Dining", amount_cents: -3000 }]);
      assert.equal(categorized.account_name, "Checking");
      await ada.ok("split_transaction", {
        transaction_id: t1,
        splits: [
          { category_id: groceries, amount_cents: -2200 },
          { category_id: dining, amount_cents: -2000 },
        ],
      });
      assert.equal((await ada.call("update_transaction", { transaction_id: t1, amount_cents: -5000 })).isError, true, "split needs splits again");
      const corner = await ada.ok("list_transactions", { payee_contains: "corner" });
      assert.equal(corner.total, 1);
      const paged = await ada.ok("list_transactions", { limit: 1 });
      assert.equal((paged.items as unknown[]).length, 1);
      assert.equal(paged.next_cursor, "1");
      const second = await ada.ok("list_transactions", { limit: 1, cursor: "1" });
      assert.notEqual((second.items as Array<{ id: string }>)[0]?.id, (paged.items as Array<{ id: string }>)[0]?.id);
      const noConfirm = await ada.call("delete_transaction", { transaction_id: t2 });
      assert.equal(noConfirm.isError, true, "delete_transaction needs confirm");
      assert.equal((await owner`select 1 from "transaction" where id = ${t2} and deleted_at is null`).length, 1);
      await ada.ok("delete_transaction", { transaction_id: t2, confirm: true });
      const deleted = await ada.ok("list_transactions", { deleted_only: true });
      assert.deepEqual((deleted.items as Array<{ id: string }>).map((row) => row.id), [t2]);
      await ada.ok("restore_transaction", { transaction_id: t2 });

      // Recurring items (PEN-206): create backfills, unlink sticks, manual link, pause, confirm guard, RLS.
      const gymTxn = (
        await ada.ok("create_transaction", { account_id: checking, occurred_on: "2026-09-06", payee: "CITY GYM 0042", amount_cents: -4100, category_id: dining })
      ).id as string;
      const gym = await ada.ok("create_recurring_item", {
        name: "Gym",
        payee_match: "city gym",
        amount_cents: -4000,
        cadence: "monthly",
        anchor_date: "2026-09-05",
        category_id: dining,
      });
      assert.equal(gym.linked, 1, "creating an item links matching history");
      const gymId = gym.id as string;
      const recurringList = await ada.ok("list_recurring_items");
      assert.deepEqual((recurringList.items as Array<{ name: string }>).map((row) => row.name), ["Gym"]);
      const gymDetail = await ada.ok("get_recurring_item", { item_id: gymId });
      assert.deepEqual((gymDetail.history as Array<{ transaction_id: string; occurrence_date: string }>).map((row) => [row.transaction_id, row.occurrence_date]), [
        [gymTxn, "2026-09-05"],
      ]);
      const gymListed = await ada.ok("list_transactions", { payee_contains: "city gym" });
      assert.deepEqual((gymListed.items as Array<{ recurring_item: unknown }>)[0]?.recurring_item, { id: gymId, name: "Gym" });
      await ada.ok("unlink_recurring_transaction", { transaction_id: gymTxn });
      assert.equal((await ada.ok("update_recurring_item", { item_id: gymId, window_days: 5 })).linked, 0, "a member's unlink sticks");
      assert.equal((await ada.call("unlink_recurring_transaction", { transaction_id: gymTxn })).isError, true, "nothing to unlink");
      const relinked = await ada.ok("link_recurring_transaction", { item_id: gymId, transaction_id: gymTxn });
      assert.equal(relinked.occurrence_date, "2026-09-05");
      await ada.ok("pause_recurring_item", { item_id: gymId });
      assert.equal(((await ada.ok("get_recurring_item", { item_id: gymId })).paused as boolean), true);
      await ada.ok("resume_recurring_item", { item_id: gymId });
      assert.ok(Array.isArray((await ada.ok("suggest_recurring_items")).items));
      const spareItem = (await ada.ok("create_recurring_item", { name: "Paycheck", amount_cents: 250000, cadence: "semimonthly", anchor_date: "2026-09-15", second_day_of_month: 30 })).id as string;
      assert.equal((await ada.call("create_recurring_item", { name: "Bad", amount_cents: 100, cadence: "semimonthly", anchor_date: "2026-09-15" })).isError, true);
      assert.equal((await ada.call("delete_recurring_item", { item_id: spareItem })).isError, true, "delete_recurring_item needs confirm");
      await ada.ok("delete_recurring_item", { item_id: spareItem, confirm: true });
      const birchAgent = await clientFor(ids.cy, birch, "write");
      assert.equal(((await birchAgent.ok("list_recurring_items")).items as unknown[]).length, 0);
      assert.equal((await birchAgent.call("get_recurring_item", { item_id: gymId })).isError, true);
      assert.equal((await birchAgent.call("unlink_recurring_transaction", { transaction_id: gymTxn })).isError, true);
      assert.equal((await birchAgent.call("delete_recurring_item", { item_id: gymId, confirm: true })).isError, true);
      assert.equal((await owner`select 1 from recurring_link where transaction_id = ${gymTxn}`).length, 1, "Birch changed nothing");

      // Payee rules, including apply-to-existing.
      const rule = (await ada.ok("create_payee_rule", { pattern: "Diner", category_id: groceries })).id as string;
      assert.equal(((await ada.ok("list_payee_rules")).items as unknown[]).length, 1);
      await ada.ok("update_payee_rule", { rule_id: rule, pattern: "diner and", category_id: groceries });
      const preview = await ada.ok("preview_payee_rule_apply", { rule_id: rule });
      assert.equal(preview.change_count, 1);
      const applied = await ada.ok("apply_payee_rule", { rule_id: rule });
      assert.equal(applied.change_count, 1);
      const recategorized = await owner<{ category_id: string }[]>`select category_id from transaction_split where transaction_id = ${t2}`;
      assert.deepEqual(recategorized.map((row) => row.category_id), [groceries]);
      assert.equal((await ada.call("delete_payee_rule", { rule_id: rule })).isError, true, "delete_payee_rule needs confirm");
      await ada.ok("delete_payee_rule", { rule_id: rule, confirm: true });

      // CSV import: inspect, propose, validate with cell errors, commit, undo.
      const csv = "Date,Description,Amount\n2026-09-01,Bakery,-12.50\n2026-09-02,Broken row,abc\n";
      const inspected = await ada.ok("inspect_csv", { csv });
      const proposed = (inspected.inspection as { proposed_mapping: Record<string, unknown> }).proposed_mapping;
      const mapping = { ...proposed, account_mode: "fixed", fixed_account_id: checking };
      const previewed = await ada.ok("preview_csv_import", { csv, mapping });
      assert.equal(previewed.ready_count, 1);
      assert.equal(previewed.error_count, 1);
      const problem = ((previewed.rows as { items: Array<{ line: number; cells: Array<{ field: string; error: string | null }> }> }).items)[0];
      assert.equal(problem?.line, 3);
      assert.ok(problem?.cells.some((cell) => cell.field === "amount" && cell.error), "cell-level amount error");
      const committed = await ada.ok("commit_csv_import", { csv, mapping });
      assert.equal(committed.added, 1);
      const imports = await ada.ok("list_csv_imports");
      assert.equal((imports.items as Array<{ import_id: string }>)[0]?.import_id, committed.import_id);
      assert.equal((await ada.call("undo_csv_import", { import_id: committed.import_id })).isError, true, "undo needs confirm");
      const undone = await ada.ok("undo_csv_import", { import_id: committed.import_id, confirm: true });
      assert.equal(undone.removed, 1);

      // Staged upload (PEN-278): send the file once, then name it by id.
      const staged = await ada.ok("stage_csv", { csv });
      const uploadId = staged.upload_id as string;
      assert.equal(staged.sha256, createHash("sha256").update(csv, "utf8").digest("hex"));
      assert.equal(staged.lines, 3);
      assert.equal((await ada.call("inspect_csv", { upload_id: uploadId, csv })).isError, true, "id and text together are refused");
      assert.equal((await ada.call("inspect_csv", {})).isError, true, "one of id or text is required");
      await ada.ok("inspect_csv", { upload_id: uploadId });
      const stagedPreview = await ada.ok("preview_csv_import", { upload_id: uploadId, mapping });
      assert.equal(stagedPreview.ready_count, 1, "the undone import can be imported again");
      const reimport = await ada.ok("commit_csv_import", { upload_id: uploadId, mapping });
      assert.equal(reimport.added, 1);
      // Second import of the same file: duplicates are skipped, nothing is added.
      const again = await ada.ok("commit_csv_import", { csv, mapping });
      assert.equal(again.added, 0);
      assert.equal(again.duplicate_count, 1);
      const dupPreview = await ada.ok("preview_csv_import", { upload_id: uploadId, mapping, rows: "all" });
      assert.equal(dupPreview.duplicate_count, 1);
      assert.equal(dupPreview.ready_count, 0);
      assert.equal((await owner`select 1 from "transaction" where household_id = ${maple} and import_batch_id = ${reimport.import_id as string}`).length, 1);
      // Undo removes exactly what that import added and nothing else.
      const undoneAgain = await ada.ok("undo_csv_import", { import_id: reimport.import_id, confirm: true });
      assert.equal(undoneAgain.removed, 1);
      assert.equal((await owner`select 1 from "transaction" where household_id = ${maple} and import_batch_id = ${reimport.import_id as string}`).length, 0);
      assert.equal((await ada.call("undo_csv_import", { import_id: reimport.import_id, confirm: true })).isError, true, "a reimport undo is refused");
      // Another household cannot read the staged file; it is immutable; it expires.
      assert.equal((await birchAgent.call("preview_csv_import", { upload_id: uploadId, mapping })).isError, true);
      await assert.rejects(() => owner`update csv_upload set content = 'Date,Description,Amount\n2026-09-01,Bakery,-99.00' where id = ${uploadId}`);
      const expired = await owner<{ id: string }[]>`
        insert into csv_upload (household_id, content, content_sha256, char_count, expires_at)
        values (${maple}, 'a,b', 'x', 3, now() - interval '1 hour') returning id`;
      assert.equal((await ada.call("inspect_csv", { upload_id: expired[0]?.id })).isError, true, "expired uploads are gone");

      // Bulk categorization (PEN-281).
      const bulkIds: string[] = [];
      for (const [index, payee] of ["Bulk Bakery", "BULK BAKERY", "Bulk Bakery Annex"].entries()) {
        bulkIds.push(
          (await ada.ok("create_transaction", { account_id: checking, occurred_on: `2026-09-0${index + 1}`, payee, amount_cents: -500 * (index + 1), category_id: dining })).id as string,
        );
      }
      const splitOne = (
        await ada.ok("create_transaction", {
          account_id: checking,
          occurred_on: "2026-09-04",
          payee: "Bulk Bakery",
          amount_cents: -900,
          splits: [{ category_id: dining, amount_cents: -400 }, { category_id: groceries, amount_cents: -500 }],
        })
      ).id as string;
      const dry = await ada.ok("categorize_by_payee", { payee: "bulk bakery", category_id: groceries, dry_run: true });
      assert.deepEqual([dry.changed, dry.skipped_split, dry.dry_run], [2, 1, true], "exact match ignores case and skips splits");
      assert.equal((await owner`select 1 from transaction_split where transaction_id = ${bulkIds[0] ?? ""} and category_id = ${groceries}`).length, 0, "dry run writes nothing");
      const byPayee = await ada.ok("categorize_by_payee", { payee: "bulk bakery", category_id: groceries });
      assert.equal(byPayee.changed, 2);
      assert.equal((await ada.ok("categorize_by_payee", { payee: "bulk bakery", category_id: groceries })).already_in_category, 2, "idempotent");
      const contains = await ada.ok("categorize_by_payee", { payee: "bulk bakery", match: "contains", category_id: groceries });
      assert.equal(contains.changed, 1, "contains also catches the Annex");
      const stale = randomUUID();
      const bulk = await ada.ok("categorize_transactions", { transaction_ids: [...bulkIds, splitOne, stale], category_id: dining });
      assert.deepEqual([bulk.changed, bulk.skipped_split, bulk.not_found], [3, 1, 1]);
      assert.equal(bulk.category_name, "Dining");
      assert.equal((await ada.call("categorize_transactions", { transaction_ids: bulkIds, category_id: randomUUID() })).isError, true, "unknown category refused");
      assert.equal((await birchAgent.call("categorize_transactions", { transaction_ids: bulkIds, category_id: groceries })).isError, true, "another household's category refused");
      const birchGroup = (await birchAgent.ok("create_category_group", { name: "Birch Group" })).id as string;
      const birchCategory = (await birchAgent.ok("create_category", { name: "Birch Bulk", kind: "expense", group_id: birchGroup })).id as string;
      // PEN-283: group names are unique ignoring case, and a category can name its group instead of an id.
      assert.equal((await birchAgent.call("create_category_group", { name: "birch group" })).isError, true, "case-insensitive duplicate group");
      const byName = await birchAgent.ok("create_category", { name: "Birch Named", kind: "expense", group_name: "BIRCH GROUP" });
      assert.equal(byName.group_id, birchGroup);
      const noGroup = await birchAgent.call("create_category", { name: "Birch Lost", kind: "expense", group_name: "Nowhere" });
      assert.equal(noGroup.isError, true);
      assert.match(noGroup.text, /create_category_group/);
      const birchBulk = await birchAgent.ok("categorize_transactions", { transaction_ids: bulkIds, category_id: birchCategory });
      assert.equal(birchBulk.not_found, 3, "another household's transactions are not found");
      const ruleBulk = await ada.ok("create_payee_rule", { pattern: "bulk bakery", category_id: groceries, apply_to_existing: true });
      assert.deepEqual([ruleBulk.applied, ruleBulk.change_count, ruleBulk.skipped_split_count], [true, 3, 1]);
      assert.equal((await owner`select 1 from transaction_split where transaction_id = ${bulkIds[0] ?? ""} and category_id = ${groceries}`).length, 1);
      await ada.ok("delete_payee_rule", { rule_id: ruleBulk.id, confirm: true });

      // Lighter reads and richer rule previews (PEN-282).
      const wide = await ada.ok("create_payee_rule", { pattern: "bulk", category_id: dining });
      const narrow = await ada.ok("create_payee_rule", { pattern: "bulk bakery annex", category_id: groceries });
      const wideRule = await ada.ok("preview_payee_rule_apply", { rule_id: wide.id });
      const sampled = wideRule.sample_payees as Array<{ payee: string; transactions: number }>;
      assert.deepEqual(sampled.map((item) => [item.payee.toLowerCase(), item.transactions]), [["bulk bakery", 3], ["bulk bakery annex", 1]], "case variants are one payee");
      const overlaps = wideRule.conflicting_rules as Array<{ rule_id: string; same_category: boolean; wins_on_import: boolean; shared_payees: string[] }>;
      assert.deepEqual(overlaps.map((item) => [item.rule_id, item.same_category, item.wins_on_import]), [[narrow.id, false, true]]);
      assert.deepEqual((await ada.ok("preview_payee_rule_apply", { rule_id: narrow.id })).conflicting_rules, [
        { rule_id: wide.id, pattern: "bulk", category_id: dining, same_category: false, wins_on_import: false, shared_payees: ["Bulk Bakery Annex"] },
      ]);
      await ada.ok("delete_payee_rule", { rule_id: wide.id, confirm: true });
      await ada.ok("delete_payee_rule", { rule_id: narrow.id, confirm: true });
      const compactList = await ada.ok("list_transactions", { payee_contains: "bulk bakery annex", compact: true });
      assert.deepEqual(Object.keys((compactList.items as Array<Record<string, unknown>>)[0] ?? {}).sort(), ["account_name", "amount_cents", "category", "category_id", "id", "occurred_on", "payee"]);
      const picked = await ada.ok("list_transactions", { payee_contains: "bulk bakery annex", fields: ["payee", "splits"] });
      assert.deepEqual(Object.keys((picked.items as Array<Record<string, unknown>>)[0] ?? {}).sort(), ["id", "payee", "splits"]);
      const splitCompact = await ada.ok("list_transactions", { payee_contains: "Bulk Bakery", compact: true, limit: 50 });
      assert.ok((splitCompact.items as Array<{ category: string }>).some((item) => item.category.startsWith("Split: ")), "split transactions say so");
      const payeesAll = await ada.ok("list_payees", { contains: "bulk" });
      const bakery = (payeesAll.items as Array<{ payee: string; transaction_count: number; total_cents: number; uncategorized_count: number }>).find((item) => item.payee.toLowerCase() === "bulk bakery");
      assert.deepEqual([bakery?.transaction_count, bakery?.total_cents, bakery?.uncategorized_count], [3, -2400, 0]);
      assert.equal((payeesAll.items as unknown[]).length, 2);
      assert.ok((payeesAll.payee_count as number) > 2, "totals are household-wide, not filtered");
      assert.deepEqual(((await ada.ok("list_payees", { contains: "bulk", sort: "name" })).items as Array<{ payee: string }>).length, 2);
      assert.equal(((await ada.ok("list_payees", { uncategorized_only: true, contains: "bulk" })).items as unknown[]).length, 0);
      assert.equal(((await birchAgent.ok("list_payees", { contains: "bulk" })).items as unknown[]).length, 0, "another household's payees stay private");
      const named = await ada.ok("list_accounts", { name: "check" });
      assert.deepEqual((named.items as Array<{ id: string }>).map((item) => item.id), [checking]);
      assert.equal(((await ada.ok("list_accounts", { name: "nope-nothing" })).items as unknown[]).length, 0);

      // Unknown bank category labels (PEN-279).
      const labelled = "Date,Description,Amount,Category\n2026-09-10,Cafe One,-4.00,Dining Out\n2026-09-11,Cafe Two,-6.00,dining out\n2026-09-12,Hardware,-20.00,Home Stuff\n";
      const labelledStage = (await ada.ok("stage_csv", { csv: labelled })).upload_id as string;
      const labelMapping = {
        ...((await ada.ok("inspect_csv", { upload_id: labelledStage })).inspection as { proposed_mapping: Record<string, unknown> }).proposed_mapping,
        account_mode: "fixed",
        fixed_account_id: checking,
      };
      const labels = await ada.ok("list_csv_category_labels", { upload_id: labelledStage, mapping: labelMapping });
      const labelItems = labels.items as Array<{ label: string; rows: number; matched_category_id: string | null }>;
      assert.deepEqual(labelItems.map((item) => [item.label, item.rows, item.matched_category_id]), [["Dining Out", 2, null], ["Home Stuff", 1, null]]);
      const strict = await ada.ok("preview_csv_import", { upload_id: labelledStage, mapping: labelMapping });
      assert.equal(strict.error_count, 3, "default stays strict");
      const mapped = await ada.ok("commit_csv_import", {
        upload_id: labelledStage,
        mapping: labelMapping,
        category_map: { "Dining Out": groceries },
        unmatched_categories: "create",
      });
      assert.equal(mapped.added, 3);
      const madeRows = await owner<{ name: string; kind: string }[]>`select name, kind from category where household_id = ${maple} and name = 'Home Stuff'`;
      assert.deepEqual(madeRows.map((row) => [row.name, row.kind]), [["Home Stuff", "expense"]]);
      assert.equal(
        (await owner`select 1 from transaction_split s join "transaction" t on t.id = s.transaction_id where t.household_id = ${maple} and t.payee in ('Cafe One', 'Cafe Two') and s.category_id = ${groceries}`).length,
        2,
      );
      await ada.ok("undo_csv_import", { import_id: mapped.import_id, confirm: true });
      const uncategorized = await ada.ok("preview_csv_import", { upload_id: labelledStage, mapping: labelMapping, unmatched_categories: "uncategorized" });
      assert.equal(uncategorized.ready_count, 3);
      assert.equal((await birchAgent.call("list_csv_category_labels", { upload_id: labelledStage, mapping: labelMapping })).isError, true);

      // Transfers (PEN-280): payment-looking rows are flagged, create_transfer writes both sides.
      const visa = (await ada.ok("create_account", { name: "Visa", type: "credit", opening_balance_cents: 0 })).id as string;
      const cardCsv = "Date,Description,Amount\n2026-09-20,Online Payment Thank You,250.00\n2026-09-21,Coffee Shop,-3.50\n2026-09-22,Refund Shoe Store,20.00\n2026-09-23,Funds Transfer,-10.00\n";
      const cardStage = (await ada.ok("stage_csv", { csv: cardCsv })).upload_id as string;
      const cardMapping = {
        ...((await ada.ok("inspect_csv", { upload_id: cardStage })).inspection as { proposed_mapping: Record<string, unknown> }).proposed_mapping,
        account_mode: "fixed",
        fixed_account_id: visa,
        category_column: null,
      };
      const cardPreview = await ada.ok("preview_csv_import", { upload_id: cardStage, mapping: cardMapping, rows: "all" });
      assert.equal(cardPreview.possible_transfer_count, 3);
      const flagged = (cardPreview.rows as { items: Array<{ line: number; possible_transfer: string | null }> }).items;
      assert.deepEqual(flagged.map((row) => [row.line, row.possible_transfer !== null]), [[2, true], [3, false], [4, true], [5, true]]);
      assert.equal(JSON.stringify((await ada.ok("preview_csv_import", { upload_id: cardStage, mapping: cardMapping })).rows).includes("Coffee Shop"), false, "unflagged ready rows stay out of the default listing");
      const transfer = await ada.ok("create_transfer", { from_account_id: checking, to_account_id: visa, amount_cents: 25000, occurred_on: "2026-09-20" });
      assert.notEqual(transfer.from_transaction_id, transfer.to_transaction_id);
      const sides = await owner<{ account_id: string; amount_cents: string; kind: string }[]>`
        select t.account_id, t.amount_cents::text, c.kind from "transaction" t
        join transaction_split s on s.transaction_id = t.id join category c on c.id = s.category_id
        where t.id in (${transfer.from_transaction_id as string}, ${transfer.to_transaction_id as string}) order by t.amount_cents`;
      assert.deepEqual(sides.map((row) => [row.account_id, row.amount_cents, row.kind]), [[checking, "-25000", "transfer"], [visa, "25000", "transfer"]]);
      await ada.ok("create_transfer", { from_account_id: checking, to_account_id: visa, amount_cents: 100, occurred_on: "2026-09-21" });
      assert.equal((await owner`select 1 from category where household_id = ${maple} and kind = 'transfer'`).length, 1, "the Transfers category is made once");
      assert.equal((await ada.call("create_transfer", { from_account_id: checking, to_account_id: checking, amount_cents: 100, occurred_on: "2026-09-21" })).isError, true, "same account refused");
      assert.equal((await ada.call("create_transfer", { from_account_id: checking, to_account_id: visa, amount_cents: -5, occurred_on: "2026-09-21" })).isError, true, "negative refused");
      assert.equal((await birchAgent.call("create_transfer", { from_account_id: checking, to_account_id: visa, amount_cents: 100, occurred_on: "2026-09-21" })).isError, true, "another household's accounts refused");

      // Plan: set, clear, switch month, copy last month.
      const books = ada.books;
      const thisMonth = `${books.asOf.year}-${String(books.asOf.month).padStart(2, "0")}`;
      const prev = books.asOf.month === 1 ? `${books.asOf.year - 1}-12` : `${books.asOf.year}-${String(books.asOf.month - 1).padStart(2, "0")}`;
      await ada.ok("set_budget", { category_id: groceries, amount_cents: 50000 });
      const plan = await ada.ok("get_plan");
      assert.equal(plan.month, thisMonth);
      assert.match(JSON.stringify(plan), /50000/);
      await ada.ok("clear_budget", { category_id: groceries });
      await ada.ok("set_budget", { category_id: dining, amount_cents: 12000, month: prev });
      const prevPlan = await ada.ok("get_plan", { month: prev });
      assert.equal(prevPlan.month, prev);
      const copyPreview = await ada.ok("preview_copy_last_month", { month: thisMonth });
      assert.equal(copyPreview.from, prev);
      const copied = await ada.ok("copy_last_month", { month: thisMonth });
      assert.equal((copied.copied as unknown[]).length, 1);
      assert.equal((await ada.call("get_plan", { month: "2026-13" })).isError, true);

      // Profit and loss: shape, granularities, validation, budget status, transfers out.
      const pnl = await ada.ok("get_profit_and_loss", { from_month: prev, to_month: thisMonth });
      assert.deepEqual((pnl.periods as Array<{ key: string }>).map((row) => row.key), [prev, thisMonth]);
      assert.equal((pnl.totals as unknown[]).length, 2);
      const pnlRows = (pnl.groups as Array<{ categories: Array<{ id: string; kind: string; periods: Array<{ actual_cents: number; budget_cents: number | null; status: string }> }> }>).flatMap((group) => group.categories);
      assert.equal(pnlRows.some((row) => row.kind === "transfer"), false, "transfers are never rows");
      const pnlDining = pnlRows.find((row) => row.id === dining);
      assert.equal(pnlDining?.periods[0]?.budget_cents, 12000, "last month's dining budget shows");
      assert.notEqual(pnlDining?.periods[0]?.status, "neutral", "a budgeted expense is under or over");
      assert.equal(pnlDining?.periods[1]?.status === "neutral" || pnlDining?.periods[1]?.budget_cents === 12000, true, "unbudgeted months are neutral (or carry the copied budget)");
      const pnlYtd = await ada.ok("get_profit_and_loss", { to_month: thisMonth, granularity: "ytd" });
      assert.equal(((pnlYtd.periods as Array<{ from: string }>)[0]?.from), `${books.asOf.year}-01`);
      assert.equal((pnlYtd.periods as unknown[]).length, books.asOf.month > 1 ? 3 : 1, "finished months, this month so far, and a total");
      assert.equal((await ada.call("get_profit_and_loss", { from_month: "2020-01", to_month: thisMonth })).isError, true, "range over 36 months refused");
      assert.equal((await ada.call("get_profit_and_loss", { from_month: thisMonth, to_month: prev })).isError, true, "reversed range refused");
      assert.equal((await ada.call("get_profit_and_loss", { granularity: "week" })).isError, true, "unknown granularity refused");

      // Home, Spend estimate, history.
      const summary = await ada.ok("get_month_summary");
      assert.equal(typeof summary.spent_cents, "number");
      const estimate = await ada.ok("get_spend_estimate");
      assert.equal(estimate.kind, "estimate");
      const estimateNow = estimate.this_month as Record<string, number>;
      assert.equal(estimateNow.estimate_cents, (summary.estimate as Record<string, number>).estimate_cents, "Home and Spend estimate agree");
      assert.equal(estimateNow.spent_so_far_cents, summary.spent_cents);
      assert.ok("next_month" in estimate && "pace" in estimate && Array.isArray(estimate.categories));
      const history = await ada.ok("get_spending_history");
      assert.equal((history.months as unknown[]).length, 12);

      // Household, invites, profile.
      const people = await ada.ok("list_household");
      assert.equal((people.members as unknown[]).length, 2);
      const invite = await ada.ok("create_invite", { email: `eve-${stamp}@tools.test` });
      assert.match(String(invite.link), /\/invite\//);
      const link = await ada.ok("copy_invite_link", { invite_id: invite.id });
      assert.equal(link.link, invite.link);
      await ada.ok("revoke_invite", { invite_id: invite.id });
      const profile = await ada.ok("get_my_profile");
      assert.equal(profile.role, "owner");
      await ada.ok("update_my_name", { name: "Ada Maple" });

      // Bank connections: status and sync, never secrets.
      const linked = await linkSimpleFinConnection(ada.books, {
        token: Buffer.from(`http://127.0.0.1:${bridge.port}/simplefin/claim/abc`).toString("base64"),
        label: "Credit union",
        sinceRaw: "2026-09-01",
      });
      assert.ok(linked.ok, JSON.stringify(linked));
      const banks = await ada.ok("list_bank_connections");
      const synced = await ada.ok("sync_bank_connection", { connection_id: linked.value.connectionId });
      const afterSync = await ada.ok("list_bank_connections");
      for (const shown of [JSON.stringify(banks), JSON.stringify(synced), JSON.stringify(afterSync)]) {
        assert.equal(shown.includes(bridge.secret), false, "no access URL or password");
        assert.equal(shown.includes("simplefin/claim"), false);
        assert.equal(shown.includes("encrypted"), false);
      }
      assert.match(JSON.stringify(afterSync), /Bridge Checking/);
      // Not the same charge: a matched row (the full flow is in connections/bank-matching.test.ts).
      const [synced1] = await owner<{ id: string }[]>`
        update "transaction" set bank_matched_at = now(), bank_occurred_on = '2026-09-15', bank_payee = 'Streaming'
        where household_id = ${maple} and bank_transaction_id = 'txn-1' returning id
      `;
      assert.ok(synced1, "sync stored the bank identity");
      const matchedList = await ada.ok("list_transactions", { payee_contains: "Streaming" });
      assert.equal((matchedList.items as Array<{ bank_matched: boolean }>)[0]?.bank_matched, true);
      const separatedMatch = await ada.ok("separate_bank_match", { transaction_id: synced1.id });
      assert.notEqual(separatedMatch.bank_copy_id, synced1.id);
      assert.equal(typeof separatedMatch.bank_copy_id, "string");
      assert.equal((await ada.call("separate_bank_match", { transaction_id: synced1.id })).isError, true, "only matched rows");
      assert.equal((await ada.call("disconnect_bank_connection", { connection_id: linked.value.connectionId })).isError, true);
      await ada.ok("disconnect_bank_connection", { connection_id: linked.value.connectionId, confirm: true });

      // Spending filters (PEN-212): the full filter on list_transactions, the breakdown, saved filter CRUD, confirm, RLS.
      const filtered = await ada.ok("list_transactions", { range: "custom", from: "2026-09-01", to: "2026-09-30", search: "corner", sources: ["manual"] });
      for (const row of filtered.items as Array<{ payee: string; occurred_on: string; sources: string[]; added_by: { id: string } | null }>) {
        assert.match(row.payee, /corner/i);
        assert.ok(row.occurred_on.startsWith("2026-09"));
        assert.deepEqual(row.sources, ["manual"]);
        assert.equal(row.added_by?.id, ids.ada, "attribution shows who added it");
      }
      assert.equal((await ada.call("list_transactions", { min_cents: 500, max_cents: 100 })).isError, true, "a bad filter is a member-facing error");
      const breakdown = await ada.ok("get_spending_breakdown", { range: "this_year" });
      assert.equal(breakdown.kind, "spending_breakdown");
      assert.equal(typeof (breakdown.totals as Record<string, number>).spent_cents, "number");
      assert.ok(Array.isArray(breakdown.by_category) && Array.isArray(breakdown.by_member) && Array.isArray((breakdown.trend as { buckets: unknown[] }).buckets));
      const savedFilter = await ada.ok("create_saved_filter", { name: "Groceries all year", filter: { range: "this_year", category_ids: [groceries] } });
      const savedId = savedFilter.id as string;
      assert.deepEqual((savedFilter.filter as { category_ids: string[] }).category_ids, [groceries]);
      assert.equal((await ada.call("create_saved_filter", { name: "groceries ALL year", filter: {} })).isError, true, "names are unique, any case");
      const fromSaved = await ada.ok("get_spending_breakdown", { saved_filter_id: savedId });
      assert.deepEqual((fromSaved.filter as { category_ids: string[]; range: string }).category_ids, [groceries]);
      const overridden = await ada.ok("list_transactions", { saved_filter_id: savedId, range: "all" });
      assert.equal((overridden as { total: number }).total >= 0, true);
      await ada.ok("rename_saved_filter", { saved_filter_id: savedId, name: "Groceries, this year" });
      assert.deepEqual(((await ada.ok("list_saved_filters")).items as Array<{ name: string }>).map((row) => row.name), ["Groceries, this year"]);
      assert.equal(((await birchAgent.ok("list_saved_filters")).items as unknown[]).length, 0, "saved filters stay in their household");
      assert.equal((await birchAgent.call("get_spending_breakdown", { saved_filter_id: savedId })).isError, true, "another household cannot use it");
      assert.equal((await birchAgent.call("delete_saved_filter", { saved_filter_id: savedId, confirm: true })).isError, true);
      assert.equal((await ada.call("delete_saved_filter", { saved_filter_id: savedId })).isError, true, "delete_saved_filter needs confirm");
      await ada.ok("delete_saved_filter", { saved_filter_id: savedId, confirm: true });
      assert.equal(((await ada.ok("list_saved_filters")).items as unknown[]).length, 0);

      // Onboarding (PEN-204): status, skip and resume, starter categories (idempotent), per household.
      const mapleSetup = await ada.ok("get_onboarding_status");
      assert.equal(mapleSetup.state, "complete", "Maple has an account, categories, transactions, a budget, and two members");
      assert.ok((mapleSetup.steps as Array<{ id: string; done: boolean }>).find((step) => step.id === "account")?.done, "Maple has an account");
      const birchBefore = await birchAgent.ok("get_onboarding_status");
      const starter = await birchAgent.ok("add_starter_categories");
      assert.ok((starter.categories_added as unknown[]).length > 0);
      assert.equal(((await birchAgent.ok("add_starter_categories")).categories_added as unknown[]).length, 0, "running it again adds nothing");
      const birchAfter = await birchAgent.ok("get_onboarding_status");
      assert.equal((birchAfter.steps as Array<{ id: string; done: boolean }>).find((step) => step.id === "categories")?.done, true);
      assert.equal(birchAfter.offer_starter_categories, false);
      assert.ok((birchAfter.required_done as number) >= (birchBefore.required_done as number));
      assert.equal((await birchAgent.ok("dismiss_onboarding")).state, "dismissed");
      assert.equal((await ada.ok("get_onboarding_status")).state, mapleSetup.state, "skipping is per household");
      assert.notEqual((await birchAgent.ok("resume_onboarding")).state, "dismissed");

      // Scope: a read grant runs every read tool and no write tool.
      const reader = await clientFor(ids.ada, maple, "read");
      for (const name of ["whoami", "list_accounts", "list_transactions", "list_categories", "get_plan", "get_profit_and_loss", "get_month_summary", "list_household", "get_spending_breakdown", "list_saved_filters", "get_onboarding_status"]) {
        await reader.ok(name);
      }
      const sneaky = await reader.call("create_transaction", {
        account_id: checking,
        occurred_on: "2026-09-22",
        payee: "Sneaky",
        amount_cents: -100,
        category_id: groceries,
      });
      assert.equal(sneaky.isError, true);
      assert.match(sneaky.text, /read and write/i);
      assert.equal((await owner`select 1 from "transaction" where payee = 'Sneaky'`).length, 0);
      for (const item of DOLLAS_TOOLS.filter((candidate) => candidate.access === "write")) {
        let ran = false;
        const guarded = { ...item, run: async () => ((ran = true), { ok: true as const, value: {}, summary: "" }) };
        const result = await runTool(guarded, reader.grant, { confirm: true }, { books: reader.books, grant: reader.grant });
        assert.equal(result.isError, true, `${item.name} must refuse a read grant`);
        assert.equal(ran, false, `${item.name} ran with a read grant`);
      }

      // RLS: Cy's agent (Birch) cannot see or change Maple.
      const cy = await clientFor(ids.cy, birch, "write");
      const cyAccounts = await cy.ok("list_accounts");
      assert.deepEqual((cyAccounts.items as Array<{ id: string }>).map((row) => row.id), [birchAccount?.id]);
      assert.equal((await cy.ok("list_transactions")).total, 0);
      assert.equal(JSON.stringify(await cy.ok("list_categories")).includes(groceries), false, "Maple's categories do not leak (Birch has its own starter Groceries)");
      const cyPnl = await cy.ok("get_profit_and_loss", { from_month: prev, to_month: thisMonth });
      assert.equal(JSON.stringify(cyPnl).includes(groceries), false, "Maple's categories stay out of Birch's profit and loss");
      assert.equal(JSON.stringify(cyPnl).includes(dining), false);
      assert.deepEqual((cyPnl.totals as Array<{ income_cents: number; expenses_cents: number }>).map((row) => [row.income_cents, row.expenses_cents]), [[0, 0], [0, 0]], "Maple's money stays out of Birch's totals");
      assert.equal((await cy.call("update_transaction", { transaction_id: t1, payee: "Hijacked" })).isError, true);
      assert.equal((await cy.call("delete_transaction", { transaction_id: t1, confirm: true })).isError, true);
      assert.equal((await cy.call("categorize_transaction", { transaction_id: t1, category_id: groceries })).isError, true);
      assert.equal((await cy.call("delete_account", { account_id: checking, confirm: true })).isError, true);
      assert.equal((await cy.call("set_budget", { category_id: groceries, amount_cents: 1 })).isError, true);
      const untouched = await owner<{ payee: string; deleted_at: Date | null }[]>`select payee, deleted_at from "transaction" where id = ${t1}`;
      assert.deepEqual([...untouched], [{ payee: "Corner Market Co", deleted_at: null }]);
      assert.equal((await owner`select 1 from ledger_account where id = ${checking}`).length, 1);

      // Ownership, leaving, deleting a household.
      assert.equal((await ada.call("transfer_ownership", { member_user_id: ids.bob })).isError, true, "transfer needs confirm");
      await ada.ok("transfer_ownership", { member_user_id: ids.bob, confirm: true });
      assert.equal((await ada.call("leave_household", {})).isError, true, "leave needs confirm");
      await ada.ok("leave_household", { confirm: true });
      assert.equal((await owner`select 1 from household_member where household_id = ${maple} and user_id = ${ids.ada}`).length, 0);
      const dee = await clientFor(ids.dee, doomed, "write");
      assert.equal((await dee.call("delete_household", { household_name: "Wrong", confirm: true })).isError, true);
      assert.equal((await dee.call("delete_household", { household_name: `Doomed ${stamp}` })).isError, true, "delete_household needs confirm");
      await dee.ok("delete_household", { household_name: `Doomed ${stamp}`, confirm: true });
      assert.equal((await owner`select 1 from household where id = ${doomed}`).length, 0);

      for (const client of [ada, reader, cy, dee]) await client.close();

      const missing = DOLLAS_TOOLS.map((item) => item.name).filter((name) => !covered.has(name));
      assert.deepEqual(missing, [], "every tool has a happy-path call in this test");
    } catch (error) {
      failure = error;
    } finally {
      try {
        bridge.server.close();
        for (const house of houses) await owner`delete from household where id = ${house}`;
        for (const id of Object.values(ids)) await owner`delete from "user" where id = ${id}`;
      } finally {
        await owner.end({ timeout: 5 });
        const { closeDb } = await import("../../db/client");
        await closeDb();
      }
    }
    if (failure) throw failure;
  });
});
