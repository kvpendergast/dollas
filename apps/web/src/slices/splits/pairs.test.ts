import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import postgres from "postgres";
import { assertAppRoleSubjectToRls, migrateWithUrl } from "../../db/apply-migrations";
import { initTelemetry } from "../../lib/telemetry";

/**
 * Transfer pairs (PEN-349), against Postgres with RLS. A paycheck split's
 * net-pay line is linked to the deposit already in the bank account (from a
 * CSV or bank sync). The deposit takes the line's transfer category, so the
 * paycheck's gross is the only income and the bank counts the net pay once.
 * Suggestions never link; bank sync never makes a second deposit or link.
 */

const OWNER_URL = "postgresql://dollas:dollas@127.0.0.1:5432/dollas";
const APP_URL = "postgresql://dollas_app:dollas@127.0.0.1:5432/dollas";

type ProviderTransactionLike = {
  providerTransactionId: string;
  providerAccountId: string;
  occurredOn: string;
  payee: string;
  amountCents: number;
  pending: boolean;
};

describe("transfer pairs (PEN-349)", () => {
  it("link net pay to the real deposit once, suggest without linking, survive sync, and unlink losslessly", async (t) => {
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

    const { createHouseholdTransaction, amendHouseholdTransaction, deleteHouseholdTransaction, listHouseholdTransactions } = await import("../activity/transactions");
    const { getHomeSummary, getSpendEstimate } = await import("../books/service");
    const { getProfitAndLoss } = await import("../plan/profit-loss");
    const { getMonthPlan } = await import("../plan/service");
    const { listHouseholdAccounts } = await import("../accounts/service");
    const { getSpendingBreakdown } = await import("../spending/service");
    const { categorizeTransactions } = await import("../activity/bulk-categorize-service");
    const { applyBankSync } = await import("../connections/apply");
    const { withActor } = await import("../../db/actor");
    const { createSplit, createSplits, updateSplit, unsplitTransaction, getSplit } = await import("./service");
    const { linkTransfer, unlinkTransfer, suggestTransferLinks, depositChoices } = await import("./pairs");
    const { listCsvImports, undoCsvImport } = await import("../activity/csv-import-service");
    const { splitUndoWarning } = await import("@dollas/domain");

    const stamp = randomBytes(4).toString("hex");
    const ids = { ada: randomUUID(), cy: randomUUID() };
    const houses: string[] = [];
    try {
      await owner`
        insert into "user" (id, name, email, email_verified) values
          (${ids.ada}, 'Ada', ${`ada-${stamp}@pairs.test`}, true), (${ids.cy}, 'Cy', ${`cy-${stamp}@pairs.test`}, true)
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
        asOf: { year: 2026, month: 10, day: 30 },
      });
      const ada = booksFor(ids.ada, maple);
      const cy = booksFor(ids.cy, birch);
      const accounts = await owner<{ id: string; name: string }[]>`
        insert into ledger_account (household_id, name, type, opening_balance_cents) values
          (${maple}, 'Payroll', 'checking', 0), (${maple}, 'Bank', 'checking', 0), (${maple}, 'Savings', 'savings', 0), (${birch}, 'Birch Bank', 'checking', 0)
        returning id, name
      `;
      const acct = (name: string) => accounts.find((row) => row.name === name)?.id ?? "";
      const cats = await owner<{ id: string; name: string }[]>`
        insert into category (household_id, name, kind, sort_order) values
          (${maple}, 'Salary', 'income', 1), (${maple}, 'Taxes', 'expense', 2), (${maple}, '401k', 'transfer', 3), (${maple}, 'Net pay', 'transfer', 4),
          (${maple}, 'Payroll (Rippling)', 'income', 5), (${maple}, 'Groceries', 'expense', 6), (${birch}, 'Birch Pay', 'income', 1)
        returning id, name
      `;
      const cat = (name: string) => cats.find((row) => row.name === name)?.id ?? "";
      const add = async (payee: string, amountCents: number, category: string, account: string, occurredOn: string) => {
        const saved = await createHouseholdTransaction(ada, { payee, occurredOn, accountId: acct(account), amountCents, splits: [{ categoryId: cat(category), amountCents }] });
        assert.ok(saved.ok, JSON.stringify(saved));
        return saved.value.id as string;
      };
      const categoriesOf = async (id: string) =>
        (await owner<{ name: string; amount_cents: number }[]>`
          select c.name, s.amount_cents from transaction_split s join category c on c.id = s.category_id where s.transaction_id = ${id} order by c.name
        `).map((row) => [row.name, row.amount_cents]);
      const pairCount = async () => (await owner<{ n: number }[]>`select count(*)::int as n from transfer_pair where household_id = ${maple}`)[0]?.n ?? 0;

      // The 2026 workaround: the CSV's deposit is income on its own, next to the paycheck's gross.
      const [batch] = await owner<{ id: string }[]>`insert into csv_import (household_id, added_count, created_by_user_id) values (${maple}, 1, ${ids.ada}) returning id`;
      const deposit = await add("ACME DIRECT DEP", 350000, "Payroll (Rippling)", "Bank", "2026-10-16");
      await owner`update "transaction" set import_batch_id = ${batch.id}, import_fingerprint = ${`fp-${stamp}`} where id = ${deposit}`;
      const paycheck = await add("Acme Payroll", 500000, "Salary", "Payroll", "2026-10-15");

      const snapshot = async () => {
        const home = await getHomeSummary(ada);
        const pnl = await getProfitAndLoss(ada, { fromMonth: "2026-10", toMonth: "2026-10" });
        const plan = await getMonthPlan(ada, { year: 2026, month: 10 });
        const estimate = await getSpendEstimate(ada);
        const balances = await listHouseholdAccounts(ada, { includeArchived: false });
        const spending = await getSpendingBreakdown(ada, { range: "this_month" }, "2026-10-30");
        for (const result of [home, pnl, plan, estimate, balances, spending]) assert.ok(result.ok, JSON.stringify(result));
        if (!home.ok || !pnl.ok || !plan.ok || !estimate.ok || !balances.ok || !spending.ok) throw new Error("unreachable");
        const balance = (name: string) => balances.value.find((row) => row.name === name)?.balanceCents ?? null;
        return {
          income: [home.value.incomeCents, pnl.value.totals[0]?.incomeCents, plan.value.incomeCents, estimate.value.thisMonth.incomeSoFarCents, spending.value.totals.incomeCents],
          spent: [home.value.spentCents, pnl.value.totals[0]?.expensesCents, estimate.value.thisMonth.spentSoFarCents, spending.value.totals.spentCents],
          balances: [balance("Payroll"), balance("Bank"), balance("Savings")],
          total: home.value.accountBalanceCents,
        };
      };
      const before = await snapshot();
      assert.deepEqual(before.income, [850000, 850000, 850000, 850000, 850000], "before: the deposit double counts the paycheck");

      // ---- Refusals: one deposit per line, never both kinds; the amount must mirror. ----
      const both = await createSplit(ada, {
        transactionId: paycheck,
        lines: [
          { categoryId: cat("Taxes"), amountCents: 100000 },
          { categoryId: cat("Net pay"), amountCents: 400000, toAccountId: acct("Bank"), depositTransactionId: deposit },
        ],
      });
      assert.equal(both.ok, false);
      assert.match(both.ok ? "" : both.memberMessage, /can't also make a new deposit/);
      const wrongAmount = await createSplit(ada, {
        transactionId: paycheck,
        lines: [
          { categoryId: cat("Taxes"), amountCents: 100000 },
          { categoryId: cat("Net pay"), amountCents: 400000, depositTransactionId: deposit },
        ],
      });
      assert.equal(wrongAmount.ok, false);
      assert.match(wrongAmount.ok ? "" : wrongAmount.memberMessage, /deposit is \$3,500.00 and the line is \$4,000.00/);
      const onTaxes = await createSplit(ada, {
        transactionId: paycheck,
        lines: [
          { categoryId: cat("Taxes"), amountCents: 150000, depositTransactionId: deposit },
          { categoryId: cat("Net pay"), amountCents: 350000 },
        ],
      });
      assert.equal(onTaxes.ok, false);
      assert.match(onTaxes.ok ? "" : onTaxes.memberMessage, /Only a transfer line/);
      assert.equal(await pairCount(), 0, "refused splits leave nothing behind");

      // ---- Suggestions name the deposit and link nothing. ----
      const pay = await createSplit(ada, {
        transactionId: paycheck,
        clientKey: `pay-${stamp}`,
        lines: [
          { categoryId: cat("Taxes"), amountCents: 100000, payee: "IRS" },
          { categoryId: cat("401k"), amountCents: 50000, payee: "401k" },
          { categoryId: cat("Net pay"), amountCents: 350000, payee: "Net pay" },
        ],
      });
      assert.ok(pay.ok, JSON.stringify(pay));
      const netPay = pay.value.lines[2]?.id ?? "";
      const decoyFar = await add("ACME DIRECT DEP", 350000, "Net pay", "Savings", "2026-10-25");
      const decoyAmount = await add("ACME DIRECT DEP", 349999, "Net pay", "Bank", "2026-10-15");
      const suggested = await suggestTransferLinks(ada, paycheck);
      assert.ok(suggested.ok, JSON.stringify(suggested));
      assert.deepEqual(
        suggested.value.lines.map((line) => [line.linePayee, line.candidates.map((row) => [row.id, row.daysApart])]),
        [["401k", []], ["Net pay", [[deposit, 1]]]],
        "same amount, other account, within the window; the far and off-by-a-cent deposits are not offered",
      );
      assert.equal(await pairCount(), 0, "suggesting never links");
      assert.deepEqual(await categoriesOf(deposit), [["Payroll (Rippling)", 350000]]);
      const choices = await depositChoices(ada, paycheck);
      assert.ok(choices.ok);
      assert.deepEqual(choices.value.map((row) => row.id).sort(), [decoyAmount, deposit].sort(), "the editor sees open deposits in the window, any amount");

      // ---- Link: the deposit becomes the transfer; income counts once; balances count once. ----
      const linked = await linkTransfer(ada, { lineTransactionId: netPay, depositTransactionId: deposit });
      assert.ok(linked.ok, JSON.stringify(linked));
      assert.equal(linked.value.status, "linked");
      assert.equal((await linkTransfer(ada, { lineTransactionId: netPay, depositTransactionId: deposit })).ok && (await pairCount()) === 1, true, "linking again is a no-op");
      assert.deepEqual(await categoriesOf(deposit), [["Net pay", 350000]]);
      const after = await snapshot();
      assert.deepEqual(after.income, [500000, 500000, 500000, 500000, 500000], "after: the gross is the only income");
      assert.deepEqual(after.spent, [100000, 100000, 100000, 100000], "taxes are spending");
      assert.deepEqual(after.balances, [0, 350000 + 349999, 350000], "Payroll clears to zero; the bank has the deposit once");
      const view = await getSplit(ada, paycheck);
      assert.ok(view.ok);
      assert.deepEqual([view.value.lines[2]?.linked?.id, view.value.lines[2]?.deposit], [deposit, null]);
      const listed = await listHouseholdTransactions(ada, { limit: 50, offset: 0 });
      assert.ok(listed.ok);
      assert.deepEqual(listed.value.items.find((row) => row.id === deposit)?.linkedTo, { lineId: netPay, parentId: paycheck, parentPayee: "Acme Payroll" });

      // ---- One link per row, same household, mirrored amount. ----
      assert.match(JSON.stringify(await linkTransfer(ada, { lineTransactionId: netPay, depositTransactionId: decoyFar })), /already linked to a deposit/);
      const k401 = pay.value.lines[1]?.id ?? "";
      const reuse = await linkTransfer(ada, { lineTransactionId: k401, depositTransactionId: deposit });
      assert.equal(reuse.ok, false);
      const mismatched = await linkTransfer(ada, { lineTransactionId: k401, depositTransactionId: decoyAmount });
      assert.match(mismatched.ok ? "" : mismatched.memberMessage, /same amount/);
      const notALine = await linkTransfer(ada, { lineTransactionId: paycheck, depositTransactionId: decoyFar });
      assert.equal(notALine.ok, false);
      assert.equal((await linkTransfer(cy, { lineTransactionId: netPay, depositTransactionId: deposit })).ok, false, "Birch cannot link Maple's rows");
      assert.equal((await unlinkTransfer(cy, deposit)).ok, false, "Birch cannot unlink Maple's rows");
      assert.equal((await suggestTransferLinks(cy, paycheck)).ok, false);
      const seenByCy = await withActor(cy.userId, (tx) => tx.execute(`select count(*)::int as n from transfer_pair`));
      assert.equal(Number((seenByCy as unknown as { n: number }[])[0]?.n ?? -1), 0, "RLS hides Maple's pairs from Birch");

      // ---- A linked deposit keeps its amount, account and category. ----
      const amendAmount = await amendHouseholdTransaction(ada, deposit, { amountCents: 340000, splits: [{ categoryId: cat("Net pay"), amountCents: 340000 }] });
      assert.match(amendAmount.ok ? "" : amendAmount.memberMessage, /linked to a paycheck/);
      const amendCategory = await amendHouseholdTransaction(ada, deposit, { splits: [{ categoryId: cat("Groceries"), amountCents: 350000 }] });
      assert.equal(amendCategory.ok, false);
      const renamed = await amendHouseholdTransaction(ada, deposit, { payee: "Acme direct deposit" });
      assert.ok(renamed.ok, JSON.stringify(renamed));
      const bulk = await categorizeTransactions(ada, { transactionIds: [deposit], categoryId: cat("Groceries") });
      assert.ok(bulk.ok);
      assert.deepEqual([bulk.value.changed, bulk.value.skippedSplit], [0, 1], "bulk categorize skips a linked deposit");
      await assert.rejects(owner`update "transaction" set amount_cents = 1 where id = ${deposit}`, /must mirror|balanced|add up/);
      await assert.rejects(
        owner`insert into transfer_pair (household_id, line_id, deposit_id, prior_categories) values (${birch}, ${k401}, ${decoyFar}, '[]')`,
        /household|policy/,
      );

      // ---- Edit split keeps the link unless the lines drop it. ----
      const kept = await updateSplit(ada, { transactionId: paycheck, payee: "Acme Payroll Inc" });
      assert.ok(kept.ok, JSON.stringify(kept));
      assert.equal(kept.value.lines[2]?.linked?.id, deposit, "an edit without lines keeps the link");
      assert.deepEqual(await categoriesOf(deposit), [["Net pay", 350000]]);
      const dropped = await updateSplit(ada, {
        transactionId: paycheck,
        lines: [
          { categoryId: cat("Taxes"), amountCents: 150000 },
          { categoryId: cat("Net pay"), amountCents: 350000 },
        ],
      });
      assert.ok(dropped.ok, JSON.stringify(dropped));
      assert.deepEqual([dropped.value.lines[1]?.linked, await categoriesOf(deposit)], [null, [["Payroll (Rippling)", 350000]]], "dropping the link gives the deposit its income category back");
      const relinked = await updateSplit(ada, {
        transactionId: paycheck,
        lines: [
          { categoryId: cat("Taxes"), amountCents: 150000 },
          { categoryId: cat("Net pay"), amountCents: 350000, depositTransactionId: deposit },
        ],
      });
      assert.ok(relinked.ok, JSON.stringify(relinked));
      const relinkedLine = relinked.value.lines[1]?.id ?? "";

      // ---- Unlink restores the old category lines exactly. ----
      const unlinked = await unlinkTransfer(ada, deposit);
      assert.ok(unlinked.ok, JSON.stringify(unlinked));
      assert.deepEqual([unlinked.value.lineId, unlinked.value.restoredCategories], [relinkedLine, true]);
      assert.deepEqual(await categoriesOf(deposit), [["Payroll (Rippling)", 350000]]);
      assert.equal((await unlinkTransfer(ada, deposit)).ok, false, "not linked anymore");
      assert.ok((await linkTransfer(ada, { lineTransactionId: relinkedLine, depositTransactionId: deposit })).ok);

      // ---- Unsplit unlinks too. ----
      const unsplit = await unsplitTransaction(ada, paycheck);
      assert.ok(unsplit.ok, JSON.stringify(unsplit));
      assert.deepEqual([await pairCount(), await categoriesOf(deposit)], [0, [["Payroll (Rippling)", 350000]]]);

      // ---- Bulk: deposit ids on net-pay lines, idempotent on client key. ----
      const bulkLines = [
        { categoryId: cat("Taxes"), amountCents: 150000 },
        { categoryId: cat("Net pay"), amountCents: 350000, depositTransactionId: deposit },
      ];
      const first = await createSplits(ada, [{ clientKey: `bulk-${stamp}`, transactionId: paycheck, lines: bulkLines }]);
      assert.ok(first.ok, JSON.stringify(first));
      assert.equal(first.value.results[0]?.status, "created");
      assert.equal(first.value.results[0]?.split?.lines[1]?.linked?.id, deposit);
      const again = await createSplits(ada, [{ clientKey: `bulk-${stamp}`, transactionId: paycheck, lines: bulkLines }]);
      assert.ok(again.ok);
      assert.deepEqual([again.value.results[0]?.status, await pairCount()], ["exists", 1], "a retry neither splits nor links twice");
      assert.deepEqual((await snapshot()).income, [500000, 500000, 500000, 500000, 500000]);

      // ---- CSV undo: warned, removes the deposit, unlinks the line. ----
      const imports = await listCsvImports(ada);
      assert.ok(imports.ok);
      const open = imports.value.open.find((row) => row.id === batch.id);
      assert.equal(open?.linkedCount, 1);
      assert.match(splitUndoWarning(open?.splitCount ?? 0, open?.replacedCount ?? 0, open?.linkedCount ?? 0), /1 deposit from this import is linked to a paycheck's net pay/);
      const undo = await undoCsvImport(ada, batch.id);
      assert.ok(undo.ok, JSON.stringify(undo));
      assert.equal(undo.value.unlinkedDeposits, 1);
      assert.match(undo.value.message, /Unlinked 1 paycheck deposit/);
      const orphan = await getSplit(ada, paycheck);
      assert.ok(orphan.ok);
      assert.deepEqual([orphan.value.lines[1]?.linked, await pairCount()], [null, 0], "the line stays, with no deposit");

      // ---- Bank sync: a deposit linked first is matched, not duplicated; its amount stays; removal unlinks. ----
      const [connection] = await owner<{ id: string }[]>`
        insert into bank_connection (household_id, provider_id, label, encrypted_access_token, key_version)
        values (${maple}, 'plaid', 'Plaid bank', ${`v1.${"A".repeat(20)}.${"B".repeat(20)}`}, 1) returning id
      `;
      const providerAccount = { providerAccountId: "plaid-checking", name: "Plaid Checking", type: "checking", currency: "USD", balanceCents: 0 } as const;
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
        providerTransactionId: id, providerAccountId: "plaid-checking", occurredOn: "2026-10-16", payee: "ACME DIRECT DEP", amountCents, pending: false, ...extra,
      });
      await sync({ added: [txn("seed", -100, { payee: "COFFEE" })] });
      const [plaidAccount] = await owner<{ account_id: string }[]>`select account_id from "transaction" where household_id = ${maple} and bank_transaction_id = 'seed'`;
      assert.ok(plaidAccount);
      const typedDeposit = await createHouseholdTransaction(ada, {
        payee: "Acme deposit", occurredOn: "2026-10-16", accountId: plaidAccount.account_id, amountCents: 350000, splits: [{ categoryId: cat("Payroll (Rippling)"), amountCents: 350000 }],
      });
      assert.ok(typedDeposit.ok);
      const typedId = typedDeposit.value.id as string;
      assert.ok((await linkTransfer(ada, { lineTransactionId: orphan.value.lines[1]?.id ?? "", depositTransactionId: typedId })).ok);
      const counts = await sync({ added: [txn("dep-1", 350000, { occurredOn: "2026-10-17" })] });
      assert.equal(counts.matched, 1, "the bank's deposit attaches to the linked row");
      const plaidRows = await owner<{ n: number }[]>`select count(*)::int as n from "transaction" where account_id = ${plaidAccount.account_id} and amount_cents = 350000 and deleted_at is null`;
      assert.equal(plaidRows[0]?.n, 1, "no second deposit");
      await sync({ modified: [txn("dep-1", 350100, { occurredOn: "2026-10-17" })] });
      const [still] = await owner<{ amount_cents: number }[]>`select amount_cents from "transaction" where id = ${typedId}`;
      assert.deepEqual([still?.amount_cents, await pairCount()], [350000, 1], "a bank update keeps the linked amount and the link");
      const netPayRows = await owner<{ bank_transaction_id: string | null }[]>`select bank_transaction_id from "transaction" where split_parent_id = ${paycheck}`;
      assert.ok(netPayRows.every((row) => row.bank_transaction_id === null), "sync never matches a paycheck line");
      assert.deepEqual((await snapshot()).income, [500000, 500000, 500000, 500000, 500000]);

      // ---- Deleting the paycheck keeps the pair dormant; a typed deposit the bank drops keeps its link. ----
      assert.ok((await deleteHouseholdTransaction(ada, paycheck)).ok);
      assert.equal(await pairCount(), 1);
      await sync({ removed: ["dep-1"] });
      const [hidden] = await owner<{ deleted_at: Date | null }[]>`select deleted_at from "transaction" where id = ${typedId}`;
      assert.deepEqual([hidden?.deleted_at, await pairCount()], [null, 1], "a typed deposit the bank drops stays the member's, link and all");
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
