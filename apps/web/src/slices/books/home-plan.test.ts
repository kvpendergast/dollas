import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import postgres from "postgres";
import { assertAppRoleSubjectToRls, migrateWithUrl } from "../../db/apply-migrations";
import { initTelemetry } from "../../lib/telemetry";

/**
 * Home's "The plan so far" (PEN-212): spent against budget for every budgeted
 * category, including one with nothing spent ($0 of $X), plus spending outside
 * the plan; with no budget it is "Spending so far". get_month_summary returns
 * the same plan.
 */

const OWNER_URL = "postgresql://dollas:dollas@127.0.0.1:5432/dollas";
const APP_URL = "postgresql://dollas_app:dollas@127.0.0.1:5432/dollas";

describe("Home spent vs budget (PEN-212)", () => {
  it("lists every budgeted category, zero spend included, and falls back without a budget", async (t) => {
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

    const { createHouseholdTransaction } = await import("../activity/transactions");
    const { getHomeSummary } = await import("./service");
    const { booksTools } = await import("./tools");

    const stamp = randomBytes(4).toString("hex");
    const ids = { ada: randomUUID(), cy: randomUUID() };
    const houses: string[] = [];
    try {
      await owner`
        insert into "user" (id, name, email, email_verified) values
          (${ids.ada}, 'Ada', ${`ada-${stamp}@home-plan.test`}, true), (${ids.cy}, 'Cy', ${`cy-${stamp}@home-plan.test`}, true)
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
        asOf: { year: 2026, month: 10, day: 10 },
      });
      const maples = booksFor(ids.ada, maple);
      const birches = booksFor(ids.cy, birch);
      const accounts = await owner<{ id: string; household_id: string }[]>`
        insert into ledger_account (household_id, name, type, opening_balance_cents) values (${maple}, 'Checking', 'checking', 0), (${birch}, 'Checking', 'checking', 0)
        returning id, household_id
      `;
      const accountOf = (house: string) => accounts.find((row) => row.household_id === house)?.id ?? "";
      const [food] = await owner<{ id: string }[]>`insert into category_group (household_id, name, sort_order) values (${maple}, 'Food', 1) returning id`;
      const cats = await owner<{ id: string; name: string; household_id: string }[]>`
        insert into category (household_id, name, kind, sort_order, group_id) values
          (${maple}, 'Groceries', 'expense', 1, ${food.id}), (${maple}, 'Gifts', 'expense', 2, null), (${maple}, 'Housing', 'expense', 3, null),
          (${maple}, 'Coffee', 'expense', 4, ${food.id}), (${birch}, 'Groceries', 'expense', 1, null)
        returning id, name, household_id
      `;
      const cat = (house: string, name: string) => cats.find((row) => row.household_id === house && row.name === name)?.id ?? "";
      const spend = async (books: typeof maples, payee: string, amountCents: number, category: string, occurredOn = "2026-10-05") => {
        const saved = await createHouseholdTransaction(books, {
          payee, occurredOn, accountId: accountOf(books.householdId), amountCents, splits: [{ categoryId: cat(books.householdId, category), amountCents }],
        });
        assert.ok(saved.ok, JSON.stringify(saved));
      };
      await spend(maples, "Corner Market", -30000, "Groceries");
      await spend(maples, "Maple Property", -160000, "Housing");
      await spend(maples, "Bean There", -1200, "Coffee");
      await spend(maples, "Last month", -99999, "Groceries", "2026-09-28");
      await owner`
        insert into category_budget (household_id, category_id, year, month, amount_cents) values
          (${maple}, ${cat(maple, "Groceries")}, 2026, 10, 50000), (${maple}, ${cat(maple, "Gifts")}, 2026, 10, 10000),
          (${maple}, ${cat(maple, "Housing")}, 2026, 10, 150000), (${maple}, ${cat(maple, "Coffee")}, 2026, 9, 5000)
      `;

      const home = await getHomeSummary(maples);
      assert.ok(home.ok, JSON.stringify(home));
      const plan = home.value.plan;
      assert.equal(plan.hasBudget, true);
      assert.deepEqual(
        plan.budgeted.map((row) => [row.name, row.spentCents, row.budgetCents, row.standing]),
        [
          ["Housing", 160000, 150000, "over"],
          ["Food · Groceries", 30000, 50000, "within"],
          ["Gifts", 0, 10000, "within"],
        ],
        "every budgeted category, including Gifts with nothing spent; last month's budget for Coffee does not count",
      );
      assert.deepEqual(plan.unbudgeted.map((row) => [row.name, row.spentCents]), [["Food · Coffee", 1200]], "spending outside the plan still shows");
      assert.equal(plan.budgetedCents, 210000);
      assert.equal(plan.spentInPlanCents, 190000);

      const tool = booksTools.find((entry) => entry.name === "get_month_summary");
      assert.ok(tool);
      const outcome = await tool.run({}, { books: maples, via: "mcp" } as never);
      assert.ok(outcome.ok);
      const shown = (outcome.value as { plan: { has_budget: boolean; budgeted: Array<{ name: string; spent_cents: number; budget_cents: number }> } }).plan;
      assert.equal(shown.has_budget, true);
      assert.deepEqual(shown.budgeted.find((row) => row.name === "Gifts"), { category_id: cat(maple, "Gifts"), name: "Gifts", spent_cents: 0, budget_cents: 10000, standing: "within", remaining_cents: 10000 });

      // No budget: "Spending so far", by category.
      await spend(birches, "Birch Market", -4200, "Groceries");
      const birchHome = await getHomeSummary(birches);
      assert.ok(birchHome.ok);
      assert.equal(birchHome.value.plan.hasBudget, false);
      assert.deepEqual(birchHome.value.plan.unbudgeted.map((row) => [row.name, row.spentCents]), [["Groceries", 4200]]);
      assert.equal(JSON.stringify(birchHome.value.plan).includes("Gifts"), false, "another household's budget stays out");
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
