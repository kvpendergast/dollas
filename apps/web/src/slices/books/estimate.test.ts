import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import postgres from "postgres";
import { assertAppRoleSubjectToRls, migrateWithUrl } from "../../db/apply-migrations";
import { initTelemetry } from "../../lib/telemetry";

/**
 * PEN-205 against a real database, as a member through RLS: the Spend estimate
 * service reads spending, recurring items and links, and budgets; Home's card
 * (get_month_summary) and get_spend_estimate show the same numbers; another
 * household's books never leak in. The formula itself is unit-tested in the
 * domain package.
 */

const OWNER_URL = "postgresql://dollas:dollas@127.0.0.1:5432/dollas";
const APP_URL = "postgresql://dollas_app:dollas@127.0.0.1:5432/dollas";
const TODAY = "2026-10-10";

describe("spend estimate service (PEN-205)", () => {
  it("adds spent so far, recurring still expected, and everyday pace, and Home matches", async (t) => {
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

    const { createHouseholdTransaction, deleteHouseholdTransaction } = await import("../activity/transactions");
    const recurring = await import("../recurring/service");
    const { getSpendEstimate, getHomeSummary } = await import("./service");
    const { booksTools } = await import("./tools");

    const stamp = randomBytes(4).toString("hex");
    const ids = { ada: randomUUID(), cy: randomUUID() };
    const houses: string[] = [];
    try {
      await owner`
        insert into "user" (id, name, email, email_verified) values
          (${ids.ada}, 'Ada', ${`ada-${stamp}@estimate.test`}, true),
          (${ids.cy}, 'Cy', ${`cy-${stamp}@estimate.test`}, true)
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
      const booksFor = (userId: string, householdId: string) => ({
        userId,
        userName: "Member",
        householdId,
        householdName: "Books",
        currency: "USD",
        timezone: "America/Chicago",
        role: "owner" as const,
        asOf: { year: 2026, month: 10, day: 10 },
      });
      const books = booksFor(ids.ada, maple);

      const [checking] = await owner<{ id: string }[]>`
        insert into ledger_account (household_id, name, type, opening_balance_cents) values (${maple}, 'Checking', 'checking', 0) returning id
      `;
      const cats = await owner<{ id: string; name: string }[]>`
        insert into category (household_id, name, kind, sort_order) values
          (${maple}, 'Groceries', 'expense', 1), (${maple}, 'Housing', 'expense', 2),
          (${maple}, 'Paycheck', 'income', 3), (${maple}, 'Transfers', 'transfer', 4)
        returning id, name
      `;
      const cat = (name: string) => cats.find((row) => row.name === name)?.id ?? "";
      const add = async (payee: string, occurredOn: string, amountCents: number, category: string) => {
        const saved = await createHouseholdTransaction(ada, {
          payee,
          occurredOn,
          accountId: checking.id,
          amountCents,
          splits: [{ categoryId: cat(category), amountCents }],
        });
        assert.ok(saved.ok, JSON.stringify(saved));
        return saved.value.id;
      };

      // Groceries: $20 a day from July 3 (the start of the 90-day window) through today.
      for (let d = Date.parse("2026-07-03T00:00:00Z"); d <= Date.parse(`${TODAY}T00:00:00Z`); d += 86_400_000) {
        await add("Corner Market", new Date(d).toISOString().slice(0, 10), -2000, "Groceries");
      }
      for (const day of ["2026-08-01", "2026-09-01", "2026-10-01"]) await add("Maple Property", day, -150000, "Housing");
      await add("Acme Payroll", "2026-10-02", 250000, "Paycheck");
      await add("To savings", "2026-10-03", -90000, "Transfers");
      const splurge = await add("Corner Market", "2026-10-05", -99999, "Groceries");
      assert.ok((await deleteHouseholdTransaction(ada, splurge)).ok, "soft-deleted spending leaves the estimate");

      const rent = await recurring.createRecurringItem(
        ada,
        { name: "Rent", payeeMatch: "maple property", amountCents: -150000, cadence: "monthly", anchorDate: "2026-08-01", categoryId: cat("Housing") },
        TODAY,
      );
      assert.ok(rent.ok && rent.value.linked === 3, JSON.stringify(rent));
      const pay = await recurring.createRecurringItem(
        ada,
        { name: "Paycheck", payeeMatch: "acme payroll", amountCents: 250000, cadence: "monthly", anchorDate: "2026-10-15", categoryId: cat("Paycheck") },
        TODAY,
      );
      assert.ok(pay.ok);
      const phone = await recurring.createRecurringItem(
        ada,
        { name: "Phone", payeeMatch: "phone co", amountCents: -7000, cadence: "monthly", anchorDate: "2026-10-20" },
        TODAY,
      );
      assert.ok(phone.ok);
      await owner`
        insert into category_budget (household_id, category_id, year, month, amount_cents) values
          (${maple}, ${cat("Groceries")}, 2026, 10, 100000), (${maple}, ${cat("Housing")}, 2026, 10, 150000)
      `;

      const result = await getSpendEstimate(books);
      assert.ok(result.ok, JSON.stringify(result));
      const estimate = result.value;
      assert.equal(estimate.today, TODAY);
      // Rent is linked, so pace is groceries only; the transfer and paycheck are not spending.
      assert.deepEqual(
        { basis: estimate.pace.basis, daily: estimate.pace.dailyCents, trailingDays: estimate.pace.trailingDays, monthDays: estimate.pace.thisMonthDays },
        { basis: "blended", daily: 2000, trailingDays: 90, monthDays: 10 },
      );
      assert.deepEqual(
        {
          spent: estimate.thisMonth.spentSoFarCents,
          paid: estimate.thisMonth.recurringPaidCents,
          expected: estimate.thisMonth.recurringExpectedCents,
          pace: estimate.thisMonth.paceCents,
          total: estimate.thisMonth.estimateCents,
          income: estimate.thisMonth.incomeCents,
          left: estimate.thisMonth.moneyLeftCents,
          budget: estimate.thisMonth.budgetCents,
          under: estimate.thisMonth.underBudgetCents,
        },
        {
          spent: 10 * 2000 + 150000,
          paid: 150000,
          expected: 7000,
          pace: 21 * 2000,
          total: 170000 + 7000 + 42000,
          income: 250000 + 250000,
          left: 500000 - 219000,
          budget: 250000,
          under: 250000 - 219000,
        },
      );
      assert.deepEqual(
        { month: estimate.nextMonth.month, recurring: estimate.nextMonth.recurringExpectedCents, total: estimate.nextMonth.estimateCents, budget: estimate.nextMonth.budgetCents },
        { month: "2026-11", recurring: 157000, total: 157000 + 30 * 2000, budget: null },
      );
      assert.deepEqual(
        estimate.categories.map((line) => [line.name, line.thisMonth.estimateCents, line.nextMonth.estimateCents]),
        [
          ["Housing", 150000, 150000],
          ["Groceries", 31 * 2000, 30 * 2000],
          ["Recurring, no category", 7000, 7000],
        ],
      );

      // Home's card and the MCP tools read the same service.
      const home = await getHomeSummary(books);
      assert.ok(home.ok);
      assert.equal(home.value.spentCents, estimate.thisMonth.spentSoFarCents, "Home's spent and the estimate's spent so far agree");
      assert.equal(home.value.estimate.estimateCents, estimate.thisMonth.estimateCents);
      assert.equal(home.value.estimate.nextMonthEstimateCents, estimate.nextMonth.estimateCents);
      const tool = booksTools.find((entry) => entry.name === "get_spend_estimate");
      assert.ok(tool);
      const outcome = await tool.run({}, { books, via: "mcp" } as never);
      assert.ok(outcome.ok);
      const value = outcome.value as { this_month: Record<string, number>; next_month: Record<string, number>; pace: Record<string, unknown>; categories: unknown[] };
      assert.equal(value.this_month.estimate_cents, 219000);
      assert.equal(value.next_month.estimate_cents, 217000);
      assert.equal(value.pace.daily_cents, 2000);
      assert.equal(value.pace.basis, "blended");
      assert.equal(value.categories.length, 3);
      assert.match(outcome.summary, /Spend estimate: about \$2,190\.00 this month/);

      // Another household sees none of it: a fresh household has no history and nothing expected.
      const other = await getSpendEstimate(booksFor(ids.cy, birch));
      assert.ok(other.ok);
      assert.equal(other.value.pace.basis, "not_enough_history");
      assert.equal(other.value.thisMonth.estimateCents, 0);
      assert.deepEqual(other.value.categories, []);
      // Nor can Cy read Maple's books by asking for them.
      const sneaky = await getSpendEstimate(booksFor(ids.cy, maple));
      assert.ok(sneaky.ok);
      assert.equal(sneaky.value.thisMonth.estimateCents, 0, "RLS hides Maple from Cy");
    } finally {
      try {
        for (const id of houses) await owner`delete from household where id = ${id}`;
        for (const id of Object.values(ids)) await owner`delete from "user" where id = ${id}`;
      } finally {
        await owner.end({ timeout: 1 });
        const { closeDb } = await import("../../db/client");
        await closeDb();
      }
    }
  });
});
