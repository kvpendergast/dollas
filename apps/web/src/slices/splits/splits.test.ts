import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import postgres from "postgres";
import { assertAppRoleSubjectToRls, migrateWithUrl } from "../../db/apply-migrations";
import { initTelemetry } from "../../lib/telemetry";

/**
 * Split transactions (PEN-348), against Postgres with RLS. Decision (a):
 * a paycheck (income parent) counts as gross income and its negative lines
 * are taxes (expense) and transfers (401k, net pay); a net-pay line can also
 * deposit into a bank account. Any other split (Costco, Venmo) leaves the
 * parent out of every total and counts the lines; a reimbursed line stays on
 * the account but leaves spending. Every report is checked for both kinds.
 */

const OWNER_URL = "postgresql://dollas:dollas@127.0.0.1:5432/dollas";
const APP_URL = "postgresql://dollas_app:dollas@127.0.0.1:5432/dollas";
const DUMP = process.env.SPLITS_DUMP === "1";

type ProviderTransactionLike = {
  providerTransactionId: string;
  providerAccountId: string;
  occurredOn: string;
  payee: string;
  amountCents: number;
  pending: boolean;
  authorizedOn?: string;
  pendingTransactionId?: string;
};

describe("split transactions (PEN-348)", () => {
  it("count once in every report, cascade, unsplit, retry safely, and stay in their household", async (t) => {
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

    const { createHouseholdTransaction, deleteHouseholdTransaction, restoreHouseholdTransaction, amendHouseholdTransaction, listHouseholdTransactions } = await import("../activity/transactions");
    const { getHomeSummary, getSpendEstimate } = await import("../books/service");
    const { getProfitAndLoss } = await import("../plan/profit-loss");
    const { getMonthPlan } = await import("../plan/service");
    const { listHouseholdAccounts } = await import("../accounts/service");
    const { listHouseholdPayees } = await import("../activity/payees-service");
    const { getSpendingBreakdown } = await import("../spending/service");
    const { suggestRecurring, createRecurringItem, linkRecurringTransaction } = await import("../recurring/service");
    const { applyBankSync } = await import("../connections/apply");
    const { withActor } = await import("../../db/actor");
    const { createSplit, createSplits, updateSplit, unsplitTransaction, listSplits, getSplit, splitDifferenceOf } = await import("./service");
    const { listCsvImports, undoCsvImport } = await import("../activity/csv-import-service");
    const { splitUndoWarning } = await import("@dollas/domain");

    const stamp = randomBytes(4).toString("hex");
    const ids = { ada: randomUUID(), cy: randomUUID() };
    const houses: string[] = [];
    try {
      await owner`
        insert into "user" (id, name, email, email_verified) values
          (${ids.ada}, 'Ada', ${`ada-${stamp}@splits.test`}, true), (${ids.cy}, 'Cy', ${`cy-${stamp}@splits.test`}, true)
      `;
      const created = await owner<{ id: string; name: string }[]>`
        insert into household (name, created_by) values (${`Maple ${stamp}`}, ${ids.ada}), (${`Birch ${stamp}`}, ${ids.cy}) returning id, name
      `;
      const maple = created.find((row) => row.name.startsWith("Maple"))?.id ?? "";
      const birch = created.find((row) => row.name.startsWith("Birch"))?.id ?? "";
      houses.push(maple, birch);
      await owner`insert into household_member (household_id, user_id, role) values (${maple}, ${ids.ada}, 'owner'), (${birch}, ${ids.cy}, 'owner')`;
      const booksFor = (userId: string, householdId: string) => ({
        userId,
        userName: "Member",
        householdId,
        householdName: "Books",
        currency: "USD",
        timezone: "America/Chicago",
        role: "owner" as const,
        asOf: { year: 2026, month: 10, day: 20 },
      });
      const ada = booksFor(ids.ada, maple);
      const cy = booksFor(ids.cy, birch);
      const accounts = await owner<{ id: string; name: string; household_id: string }[]>`
        insert into ledger_account (household_id, name, type, opening_balance_cents) values
          (${maple}, 'Payroll', 'checking', 0), (${maple}, 'Bank', 'checking', 0), (${maple}, 'Card', 'credit', 0), (${birch}, 'Birch Bank', 'checking', 0)
        returning id, name, household_id
      `;
      const acct = (name: string) => accounts.find((row) => row.name === name)?.id ?? "";
      const cats = await owner<{ id: string; name: string; household_id: string }[]>`
        insert into category (household_id, name, kind, sort_order) values
          (${maple}, 'Salary', 'income', 1), (${maple}, 'Taxes', 'expense', 2), (${maple}, '401k', 'transfer', 3), (${maple}, 'Net pay', 'transfer', 4),
          (${maple}, 'Groceries', 'expense', 5), (${maple}, 'Household', 'expense', 6), (${maple}, 'Gifts', 'expense', 7), (${birch}, 'Birch Food', 'expense', 1)
        returning id, name, household_id
      `;
      const cat = (name: string) => cats.find((row) => row.name === name)?.id ?? "";
      await owner`
        insert into category_budget (household_id, category_id, year, month, amount_cents) values
          (${maple}, ${cat("Groceries")}, 2026, 10, 50000), (${maple}, ${cat("Taxes")}, 2026, 10, 120000), (${maple}, ${cat("Household")}, 2026, 10, 10000)
      `;
      const add = async (payee: string, amountCents: number, category: string, account: string, occurredOn = "2026-10-15") => {
        const saved = await createHouseholdTransaction(ada, { payee, occurredOn, accountId: acct(account), amountCents, splits: [{ categoryId: cat(category), amountCents }] });
        assert.ok(saved.ok, JSON.stringify(saved));
        return saved.value.id as string;
      };
      const paycheck = await add("Acme Payroll", 500000, "Salary", "Payroll");
      const costco = await add("Costco", -20000, "Groceries", "Card", "2026-10-16");

      const snapshot = async () => {
        const home = await getHomeSummary(ada);
        const pnl = await getProfitAndLoss(ada, { fromMonth: "2026-10", toMonth: "2026-10" });
        const plan = await getMonthPlan(ada, { year: 2026, month: 10 });
        const estimate = await getSpendEstimate(ada);
        const balances = await listHouseholdAccounts(ada, { includeArchived: false });
        const payees = await listHouseholdPayees(ada);
        const spending = await getSpendingBreakdown(ada, { range: "this_month" }, "2026-10-20");
        for (const result of [home, pnl, plan, estimate, balances, payees, spending]) assert.ok(result.ok, JSON.stringify(result));
        if (!home.ok || !pnl.ok || !plan.ok || !estimate.ok || !balances.ok || !payees.ok || !spending.ok) throw new Error("unreachable");
        if (DUMP) console.log(JSON.stringify({ home: home.value, pnl: pnl.value, plan: plan.value, estimate: estimate.value, balances: balances.value, payees: payees.value, spending: spending.value }, null, 1));
        return { home: home.value, pnl: pnl.value, plan: plan.value, estimate: estimate.value, balances: balances.value, payees: payees.value, spending: spending.value };
      };
      const before = await snapshot();
      assert.deepEqual([before.home.incomeCents, before.home.spentCents, before.home.accountBalanceCents], [500000, 20000, 480000]);

      // ---- Refusals: the difference is reported, a child or a split cannot be split. ----
      const short = await createSplit(ada, { transactionId: paycheck, lines: [{ categoryId: cat("Taxes"), amountCents: 100000 }] });
      assert.equal(short.ok, false);
      assert.match(short.ok ? "" : short.memberMessage, /left to assign/);
      assert.equal(splitDifferenceOf(short), 400000);
      const over = await createSplit(ada, { transactionId: costco, lines: [{ categoryId: cat("Groceries"), amountCents: 25000 }] });
      assert.equal(splitDifferenceOf(over), -5000);
      const depositOnCostco = await createSplit(ada, { transactionId: costco, lines: [{ categoryId: cat("Groceries"), amountCents: 20000, toAccountId: acct("Bank") }] });
      assert.equal(depositOnCostco.ok, false, "only an income split deposits");

      // ---- A paycheck: gross income, taxes and transfers, net pay into Bank. ----
      const pay = await createSplit(ada, {
        transactionId: paycheck,
        clientKey: "pay-2026-10-15",
        lines: [
          { categoryId: cat("Taxes"), amountCents: 100000, payee: "IRS" },
          { categoryId: cat("401k"), amountCents: 50000, payee: "401k" },
          { categoryId: cat("Net pay"), amountCents: 350000, payee: "Net pay", toAccountId: acct("Bank") },
        ],
      });
      assert.ok(pay.ok, JSON.stringify(pay));
      assert.equal(pay.value.status, "created");
      assert.equal(pay.value.kind, "income");
      assert.deepEqual(pay.value.lines.map((line) => [line.payee, line.amountCents, line.deposit?.accountName ?? null, line.deposit?.amountCents ?? null]), [
        ["IRS", -100000, null, null],
        ["401k", -50000, null, null],
        ["Net pay", -350000, "Bank", 350000],
      ]);
      const retried = await createSplit(ada, { transactionId: paycheck, clientKey: "pay-2026-10-15", lines: [{ categoryId: cat("Taxes"), amountCents: 500000 }] });
      assert.ok(retried.ok && retried.value.status === "exists" && retried.value.lines.length === 3, "a retry with the same key changes nothing");
      const twice = await createSplit(ada, { transactionId: paycheck, lines: [{ categoryId: cat("Taxes"), amountCents: 500000 }] });
      assert.equal(twice.ok, false, "a split is changed with updateSplit");
      const child = pay.value.lines[0]?.id ?? "";
      assert.equal((await createSplit(ada, { transactionId: child, lines: [{ categoryId: cat("Taxes"), amountCents: 100000 }] })).ok, false, "a line cannot be split");

      // ---- A Costco run: the parent leaves the totals, a reimbursed line leaves spending. ----
      const store = await createSplit(ada, {
        transactionId: costco,
        lines: [
          { categoryId: cat("Groceries"), amountCents: 12000 },
          { categoryId: cat("Household"), amountCents: 5000 },
          { categoryId: cat("Gifts"), amountCents: 3000, reimbursed: true, payee: "Costco for Bea" },
        ],
      });
      assert.ok(store.ok, JSON.stringify(store));
      assert.equal(store.value.kind, "allocation");
      assert.equal((await createSplit(ada, { transactionId: paycheck, clientKey: "pay-2026-10-15", lines: [] })).ok, true, "same key on the same row is still exists");
      const stolenKey = await createSplit(ada, { transactionId: costco, clientKey: "pay-2026-10-15", lines: [{ categoryId: cat("Groceries"), amountCents: 20000 }] });
      assert.equal(stolenKey.ok, false, "a client key belongs to one transaction");

      const after = await snapshot();
      assert.deepEqual([after.home.incomeCents, after.home.spentCents, after.home.accountBalanceCents], [500000, 117000, 330000], "Home: gross income; taxes and Costco lines spent; net pay lands in Bank");
      assert.deepEqual(after.home.plan.budgeted.map((row) => [row.name, row.spentCents]), [["Taxes", 100000], ["Groceries", 12000], ["Household", 5000]]);
      assert.deepEqual(after.home.plan.unbudgeted, [], "the reimbursed Gifts line is not spending");
      assert.deepEqual([after.pnl.totals[0]?.incomeCents, after.pnl.totals[0]?.expensesCents], [500000, 117000], "P&L");
      const pnlRow = (name: string) => after.pnl.groups.flatMap((group) => group.categories).find((row) => row.name === name)?.periods[0]?.actualCents ?? 0;
      assert.deepEqual(["Salary", "Taxes", "Groceries", "Household", "Gifts"].map(pnlRow), [500000, 100000, 12000, 5000, 0]);
      const planRow = (name: string) => after.plan.sections.flatMap((section) => section.categories).find((row) => row.name === name)?.spentCents;
      assert.deepEqual([after.plan.incomeCents, planRow("Taxes"), planRow("Groceries"), planRow("Household"), planRow("Gifts")], [500000, 100000, 12000, 5000, 0], "budgets");
      assert.deepEqual([after.estimate.thisMonth.spentSoFarCents, after.estimate.thisMonth.incomeSoFarCents], [117000, 500000], "estimate");
      assert.deepEqual(after.estimate.categories.map((row) => [row.name, row.thisMonth.spentSoFarCents]).sort(), [["Groceries", 12000], ["Household", 5000], ["Taxes", 100000]]);
      const balance = (name: string) => after.balances.find((row) => row.name === name)?.balanceCents;
      assert.deepEqual([balance("Payroll"), balance("Bank"), balance("Card")], [0, 350000, -20000], "balances: the paycheck clears Payroll, the deposit is in Bank, the card still owes the whole charge");
      assert.deepEqual(after.payees.payees.map((row) => [row.payee, row.totalCents]), [["Acme Payroll", 500000], ["Costco", -20000]], "payees are top-level rows");
      assert.deepEqual([after.spending.totals.spentCents, after.spending.totals.incomeCents], [117000, 500000], "spending");
      assert.equal(after.spending.byCategory.some((row) => row.name === "Gifts"), false);

      // ---- Activity: the list carries the group; children and parents are locked to direct edits. ----
      const listed = await listHouseholdTransactions(ada, { limit: 50, offset: 0 });
      assert.ok(listed.ok, JSON.stringify(listed));
      const roleOf = (id: string) => listed.value.items.find((row) => row.id === id)?.splitGroup?.role ?? null;
      assert.deepEqual([roleOf(paycheck), roleOf(child), roleOf(pay.value.lines[2]?.deposit?.id ?? "")], ["parent", "line", "deposit"]);
      const amendChild = await amendHouseholdTransaction(ada, child, { payee: "x", occurredOn: "2026-10-15", accountId: acct("Payroll"), amountCents: -100000, splits: [{ categoryId: cat("Taxes"), amountCents: -100000 }] });
      assert.equal(amendChild.ok, false);
      assert.match(amendChild.ok ? "" : amendChild.memberMessage, /part of a split/);
      const amendParent = await amendHouseholdTransaction(ada, paycheck, { payee: "x", occurredOn: "2026-10-15", accountId: acct("Payroll"), amountCents: 500000, splits: [{ categoryId: cat("Salary"), amountCents: 500000 }] });
      assert.equal(amendParent.ok, false);
      assert.equal((await deleteHouseholdTransaction(ada, child)).ok, false, "a line is removed through its split");

      // ---- The database holds the invariant on its own. ----
      await assert.rejects(owner`update "transaction" set amount_cents = amount_cents - 1 where id = ${child}`, /add up|balanced|split/);
      await assert.rejects(owner`update "transaction" set occurred_on = '2026-10-01' where id = ${child}`, /match their parent|split/);

      // ---- Recurring: children cannot link; suggestions come from top-level rows. ----
      const item = await createRecurringItem(ada, { name: "Taxes", payeeMatch: "IRS", amountCents: -100000, cadence: "monthly", anchorDate: "2026-10-15", categoryId: cat("Taxes"), accountId: acct("Payroll") }, "2026-10-20");
      assert.ok(item.ok, JSON.stringify(item));
      assert.equal(item.value.linked, 0, "backfill skips split lines");
      assert.equal((await linkRecurringTransaction(ada, item.value.id, child)).ok, false, "a split line cannot be linked");

      // ---- Bulk: idempotent on client key, per item or atomic, with replaced workaround rows. ----
      const aug = await add("Acme Payroll", 500000, "Salary", "Payroll", "2026-08-15");
      const sep = await add("Acme Payroll", 500000, "Salary", "Payroll", "2026-09-15");
      const workaround = await add("Payroll (Rippling) taxes", -100000, "Taxes", "Payroll", "2026-09-15");
      const lines = [
        { categoryId: cat("Taxes"), amountCents: 100000, payee: "IRS" },
        { categoryId: cat("Net pay"), remainderPercent: 100, payee: "Net pay" },
      ];
      const atomic = await createSplits(ada, [
        { clientKey: "pay-2026-08-15", transactionId: aug, lines },
        { clientKey: "pay-2026-09-15", transactionId: sep, lines: [{ categoryId: cat("Taxes"), amountCents: 1 }] },
      ], "atomic");
      assert.ok(atomic.ok, JSON.stringify(atomic));
      assert.deepEqual(atomic.value.results.map((row) => row.status), ["rolled_back", "error"]);
      assert.equal(atomic.value.results[1]?.differenceCents, 499999);
      const augSplits = await listSplits(ada, { clientKeyPrefix: "pay-2026-08", limit: 10, offset: 0 });
      assert.ok(augSplits.ok);
      assert.equal(augSplits.value.total, 0, "atomic: nothing was created");
      const bulkItems = [
        { clientKey: "pay-2026-08-15", transactionId: aug, lines },
        { clientKey: "pay-2026-09-15", transactionId: sep, lines, replacesTransactionIds: [workaround] },
        { clientKey: "pay-2026-10-15", transactionId: paycheck, lines },
      ];
      const bulk = await createSplits(ada, bulkItems, "per_item");
      assert.ok(bulk.ok, JSON.stringify(bulk));
      assert.deepEqual([bulk.value.created, bulk.value.existing, bulk.value.failed], [2, 1, 0]);
      assert.equal(bulk.value.results[0]?.split?.lines[1]?.amountCents, -400000, "the remainder line takes what the taxes leave");
      const replay = await createSplits(ada, bulkItems, "per_item");
      assert.ok(replay.ok);
      assert.deepEqual([replay.value.created, replay.value.existing], [0, 3], "a replay is a no-op");
      const [hidden] = await owner<{ deleted_at: Date | null; split_replaced_by: string | null }[]>`select deleted_at, split_replaced_by from "transaction" where id = ${workaround}`;
      assert.ok(hidden?.deleted_at && hidden.split_replaced_by === sep, "the workaround row is hidden and points at its split");
      assert.equal((await restoreHouseholdTransaction(ada, workaround)).ok, false, "unsplit brings it back, not restore");
      const incomeSplits = await listSplits(ada, { kind: "income", limit: 10, offset: 0 });
      assert.ok(incomeSplits.ok);
      assert.deepEqual(incomeSplits.value.items.map((row) => row.occurredOn), ["2026-10-15", "2026-09-15", "2026-08-15"]);
      assert.equal((await listSplits(ada, { limit: 10, offset: 0 })).ok, true);
      const suggestions = await suggestRecurring(ada, "2026-10-20");
      assert.ok(suggestions.ok, JSON.stringify(suggestions));
      assert.equal(JSON.stringify(suggestions.value).includes("Net pay"), false, "split lines never seed a recurring suggestion");
      const payees = await listHouseholdPayees(ada);
      assert.ok(payees.ok);
      assert.deepEqual(payees.value.payees.map((row) => row.payee).sort(), ["Acme Payroll", "Costco"], "IRS and Net pay lines are not payees");

      // ---- Edit: lines move with the parent; the parent's date and payee change once. ----
      const edited = await updateSplit(ada, {
        transactionId: costco,
        occurredOn: "2026-10-17",
        payee: "Costco Wholesale",
        lines: [{ categoryId: cat("Groceries"), amountCents: 15000 }, { categoryId: cat("Household"), amountCents: 5000 }],
      });
      assert.ok(edited.ok, JSON.stringify(edited));
      const costcoLines = await owner<{ occurred_on: string; account_id: string }[]>`select occurred_on::text, account_id from "transaction" where split_parent_id = ${costco} and deleted_at is null`;
      assert.deepEqual(costcoLines.map((row) => [row.occurred_on, row.account_id]), [["2026-10-17", acct("Card")], ["2026-10-17", acct("Card")]]);
      const editedShort = await updateSplit(ada, { transactionId: costco, lines: [{ categoryId: cat("Groceries"), amountCents: 1000 }] });
      assert.equal(splitDifferenceOf(editedShort), 19000);
      const moved = await updateSplit(ada, { transactionId: costco, amountCents: -21000 });
      assert.equal(moved.ok, false, "a new amount needs lines that add up to it");
      const resized = await updateSplit(ada, { transactionId: costco, amountCents: -21000, lines: [{ categoryId: cat("Groceries"), amountCents: 16000 }, { categoryId: cat("Household"), amountCents: 5000 }] });
      assert.ok(resized.ok, JSON.stringify(resized));

      // ---- Delete and restore cascade to the lines and deposits. ----
      assert.ok((await deleteHouseholdTransaction(ada, paycheck)).ok);
      const gone = await owner<{ n: number }[]>`select count(*)::int as n from "transaction" where split_parent_id = ${paycheck} and deleted_at is null`;
      assert.equal(gone[0]?.n, 0, "deleting the paycheck removes its lines and deposit");
      assert.ok((await restoreHouseholdTransaction(ada, paycheck)).ok);
      const back = await owner<{ n: number }[]>`select count(*)::int as n from "transaction" where split_parent_id = ${paycheck} and deleted_at is null`;
      assert.equal(back[0]?.n, 4, "restore brings back the three lines and the deposit; the bulk replay did not touch them");

      // ---- Unsplit: the lines go, the replaced rows return, the parent counts alone. ----
      const undone = await unsplitTransaction(ada, sep);
      assert.ok(undone.ok, JSON.stringify(undone));
      assert.deepEqual([undone.value.removedLines, undone.value.restored], [2, 1]);
      const [restoredRow] = await owner<{ deleted_at: Date | null }[]>`select deleted_at from "transaction" where id = ${workaround}`;
      assert.equal(restoredRow?.deleted_at, null);
      assert.equal((await unsplitTransaction(ada, sep)).ok, false, "not split anymore");
      assert.ok((await unsplitTransaction(ada, costco)).ok);
      const unsplitBalances = await listHouseholdAccounts(ada, { includeArchived: false });
      assert.ok(unsplitBalances.ok);
      assert.equal(unsplitBalances.value.find((row) => row.name === "Card")?.balanceCents, -21000);
      const get = await getSplit(ada, costco);
      assert.equal(get.ok, false);

      // ---- Household isolation. ----
      assert.equal((await getSplit(cy, paycheck)).ok, false, "Birch cannot read Maple's split");
      assert.equal((await unsplitTransaction(cy, paycheck)).ok, false);
      assert.equal((await updateSplit(cy, { transactionId: paycheck, payee: "Hijack" })).ok, false);
      const cyBulk = await createSplits(cy, [{ clientKey: "pay-2026-10-15", transactionId: paycheck, lines }], "per_item");
      assert.ok(cyBulk.ok);
      assert.equal(cyBulk.value.results[0]?.status, "error", "a key in another household does not reach Maple's row");
      const cyRow = await createHouseholdTransaction(cy, { payee: "Birch shop", occurredOn: "2026-10-10", accountId: acct("Birch Bank"), amountCents: -1000, splits: [{ categoryId: cat("Birch Food"), amountCents: -1000 }] });
      assert.ok(cyRow.ok);
      assert.equal((await createSplit(cy, { transactionId: cyRow.value.id as string, lines: [{ categoryId: cat("Groceries"), amountCents: 1000 }] })).ok, false, "Maple's category is not Birch's");
      assert.equal((await createSplit(cy, { transactionId: cyRow.value.id as string, clientKey: "pay-2026-10-15", lines: [{ categoryId: cat("Birch Food"), amountCents: 1000 }] })).ok, true, "client keys are per household");
      const cySplits = await listSplits(cy, { limit: 10, offset: 0 });
      assert.ok(cySplits.ok);
      assert.equal(cySplits.value.total, 1);

      // ---- CSV undo with a split built on it: warned, then removed with the split. ----
      const [batch] = await owner<{ id: string }[]>`insert into csv_import (household_id, added_count, created_by_user_id) values (${maple}, 1, ${ids.ada}) returning id`;
      const imported = await add("Venmo Bea", -6000, "Groceries", "Bank", "2026-10-18");
      await owner`update "transaction" set import_batch_id = ${batch.id}, import_fingerprint = ${`fp-${stamp}`} where id = ${imported}`;
      assert.ok((await createSplit(ada, { transactionId: imported, lines: [{ categoryId: cat("Groceries"), amountCents: 3000 }, { categoryId: cat("Gifts"), amountCents: 3000, reimbursed: true }] })).ok);
      const imports = await listCsvImports(ada);
      assert.ok(imports.ok);
      const open = imports.value.open.find((row) => row.id === batch.id);
      assert.deepEqual([open?.splitCount, open?.replacedCount], [1, 0]);
      assert.match(splitUndoWarning(open?.splitCount ?? 0, open?.replacedCount ?? 0), /1 split is built on this import/);
      const undo = await undoCsvImport(ada, batch.id);
      assert.ok(undo.ok, JSON.stringify(undo));
      assert.equal(undo.value.removedSplits, 1);
      assert.match(undo.value.message, /removed 1 split/);
      const leftovers = await owner<{ n: number }[]>`select count(*)::int as n from "transaction" where split_parent_id = ${imported}`;
      assert.equal(leftovers[0]?.n, 0, "the split's lines go with the import");

      // ---- Bank sync never matches into a split and keeps the member's split amounts. ----
      const [connection] = await owner<{ id: string }[]>`
        insert into bank_connection (household_id, provider_id, label, encrypted_access_token, key_version)
        values (${maple}, 'plaid', 'Plaid bank', ${`v1.${"A".repeat(20)}.${"B".repeat(20)}`}, 1) returning id
      `;
      const providerAccount = { providerAccountId: "plaid-card", name: "Plaid Card", type: "credit", currency: "USD", balanceCents: 0 } as const;
      const sync = (page: { added?: ProviderTransactionLike[]; modified?: ProviderTransactionLike[]; removed?: string[] }) =>
        withActor(ada.userId, (tx) =>
          applyBankSync(tx, {
            householdId: maple,
            connectionId: connection.id,
            providerId: "plaid",
            since: "2026-09-01",
            accounts: [providerAccount],
            transactions: page.added ?? [],
            modified: page.modified ?? [],
            removed: page.removed ?? [],
            nextCursor: `cursor-${randomBytes(3).toString("hex")}`,
          }),
        );
      const txn = (id: string, amountCents: number, extra: Partial<ProviderTransactionLike> = {}): ProviderTransactionLike => ({
        providerTransactionId: id, providerAccountId: "plaid-card", occurredOn: "2026-10-12", payee: "TARGET 0042", amountCents, pending: false, ...extra,
      });
      await sync({ added: [txn("target-1", -8000)] });
      const [bankRow] = await owner<{ id: string; account_id: string }[]>`select id, account_id from "transaction" where household_id = ${maple} and bank_transaction_id = 'target-1'`;
      assert.ok(bankRow);
      assert.ok((await createSplit(ada, { transactionId: bankRow.id, lines: [{ categoryId: cat("Groceries"), amountCents: 5000 }, { categoryId: cat("Household"), amountCents: 3000 }] })).ok);
      const typed = await createHouseholdTransaction(ada, { payee: "Target", occurredOn: "2026-10-13", accountId: bankRow.account_id, amountCents: -2500, splits: [{ categoryId: cat("Groceries"), amountCents: -2500 }] });
      assert.ok(typed.ok);
      assert.ok((await createSplit(ada, { transactionId: typed.value.id as string, lines: [{ categoryId: cat("Groceries"), amountCents: 2500 }] })).ok);
      const counts = await sync({ added: [txn("target-2", -2500, { occurredOn: "2026-10-13", payee: "TARGET" })], modified: [txn("target-1", -8100, { payee: "TARGET STORE" })] });
      assert.equal(counts.matched, 0, "a typed-in split is never matched to a bank charge");
      assert.equal(counts.transactions, 1);
      const [kept] = await owner<{ amount_cents: number; payee: string }[]>`select amount_cents, payee from "transaction" where id = ${bankRow.id}`;
      assert.deepEqual([kept?.amount_cents, kept?.payee], [-8000, "TARGET 0042"], "a bank update leaves a split's amount and payee to the member");
      const childCount = await owner<{ n: number }[]>`select count(*)::int as n from "transaction" where split_parent_id = ${bankRow.id} and deleted_at is null`;
      assert.equal(childCount[0]?.n, 2);
      await sync({ removed: ["target-1"] });
      const hiddenLines = await owner<{ n: number }[]>`select count(*)::int as n from "transaction" where split_parent_id = ${bankRow.id} and deleted_at is null`;
      assert.equal(hiddenLines[0]?.n, 0, "the bank removing a split charge hides its lines too");
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
