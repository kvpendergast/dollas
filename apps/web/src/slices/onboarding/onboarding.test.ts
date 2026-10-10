import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { STARTER_CATEGORIES, type ColumnMapping } from "@dollas/domain";
import postgres from "postgres";
import { assertAppRoleSubjectToRls, migrateWithUrl } from "../../db/apply-migrations";
import { initTelemetry } from "../../lib/telemetry";

/**
 * PEN-204 against a real database, as members through RLS: each checklist
 * step completes from real data on its own write path (the triggers in
 * migration 0032), the invite step waits for the first account, starter
 * categories are idempotent, skip and resume persist per household and are
 * shared by its members, and another household cannot read or change it.
 */

const OWNER_URL = "postgresql://dollas:dollas@127.0.0.1:5432/dollas";
const APP_URL = "postgresql://dollas_app:dollas@127.0.0.1:5432/dollas";
const TODAY = "2026-10-10";
const STARTER_COUNT = STARTER_CATEGORIES.reduce((sum, group) => sum + group.categories.length, 0);

describe("onboarding checklist (PEN-204)", () => {
  it("completes steps from real data, gates the invite, and keeps skip and resume per household", async (t) => {
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
    const { householdOnboarding } = await import("../../db/schema");
    const { eq, sql } = await import("drizzle-orm");
    const { startHousehold } = await import("../household/start");
    const { addHouseholdAccount, archiveHouseholdAccount } = await import("../accounts/service");
    const { createHouseholdTransaction } = await import("../activity/transactions");
    const { commitCsvImport } = await import("../activity/csv-import-service");
    const { ensureFallbackCategory } = await import("../connections/apply");
    const { setBudget } = await import("../plan/service");
    const { createHouseholdInvite } = await import("../household/invites");
    const { createRecurringItem } = await import("../recurring/service");
    const onboarding = await import("./service");

    const stamp = randomBytes(4).toString("hex");
    const ids = { ada: randomUUID(), ben: randomUUID(), cy: randomUUID(), dot: randomUUID() };
    const houses: string[] = [];
    const statusOf = async (who: { userId: string; householdId: string }) => {
      const status = await onboarding.getOnboardingStatus(who);
      assert.ok(status.ok, JSON.stringify(status));
      return status.value;
    };
    const done = (status: Awaited<ReturnType<typeof statusOf>>, id: string) => status.steps.find((step) => step.id === id)?.done ?? false;
    try {
      await owner`
        insert into "user" (id, name, email, email_verified) values
          (${ids.ada}, 'Ada', ${`ada-${stamp}@onboarding.test`}, true),
          (${ids.ben}, 'Ben', ${`ben-${stamp}@onboarding.test`}, true),
          (${ids.cy}, 'Cy', ${`cy-${stamp}@onboarding.test`}, true),
          (${ids.dot}, 'Dot', ${`dot-${stamp}@onboarding.test`}, true)
      `;
      // ---- A fresh household, started the way Welcome does it. ----
      const started = await startHousehold(ids.ada, `Maple ${stamp}`);
      assert.ok(started.ok, JSON.stringify(started));
      const maple = started.value.householdId;
      houses.push(maple);
      const ada = { userId: ids.ada, householdId: maple };

      let status = await statusOf(ada);
      assert.equal(status.state, "checklist");
      assert.equal(status.requiredDone, 0);
      assert.deepEqual(status.steps.map((step) => step.id), ["account", "categories", "transactions", "budget", "recurring"]);
      assert.deepEqual(status.waiting.map((row) => row.id), ["invite"], "the invite waits for the first account");
      assert.equal(status.offerStarterCategories, true);

      // The fallback categories import and sync create do not count as set up.
      await withActor(ids.ada, (tx) => ensureFallbackCategory(tx, maple, "expense"));
      status = await statusOf(ada);
      assert.equal(done(status, "categories"), false);
      assert.equal(status.offerStarterCategories, true, "only fallbacks still offers the starter set");

      // ---- (1) First account; the invite is offered from here. ----
      const account = await addHouseholdAccount(ada, { name: "Checking", type: "checking", opening: "100.00", owed: false });
      assert.ok(account.ok, JSON.stringify(account));
      status = await statusOf(ada);
      assert.equal(done(status, "account"), true);
      assert.ok(status.steps.some((step) => step.id === "invite"), "invite shows once an account exists");
      assert.deepEqual(status.waiting, []);
      assert.equal(status.requiredTotal, 5);
      assert.equal(status.nextStep, "categories");

      // ---- (2) Starter categories: one click, idempotent. ----
      const starter = await onboarding.addStarterCategories(ada);
      assert.ok(starter.ok, JSON.stringify(starter));
      assert.equal(starter.value.categoriesAdded.length, STARTER_COUNT);
      assert.equal(starter.value.groupsAdded.length, STARTER_CATEGORIES.length);
      const again = await onboarding.addStarterCategories(ada);
      assert.ok(again.ok);
      assert.equal(again.value.categoriesAdded.length, 0, "a second run adds nothing");
      assert.equal(again.value.groupsAdded.length, 0);
      const [{ n: categoryCount }] = await owner<{ n: number }[]>`select count(*)::int as n from category where household_id = ${maple}`;
      assert.equal(categoryCount, STARTER_COUNT + 1, "the starter set plus the fallback, no duplicates");
      status = await statusOf(ada);
      assert.equal(done(status, "categories"), true);
      assert.equal(status.offerStarterCategories, false);
      const [groceries] = await owner<{ id: string }[]>`select id from category where household_id = ${maple} and name = 'Groceries'`;
      const [fallbackSort] = await owner<{ sort_order: number }[]>`select sort_order from category where household_id = ${maple} and name = 'Uncategorized'`;
      assert.equal(fallbackSort.sort_order, 1000, "the fallback stays last");

      // ---- (3) A transaction. ----
      const typed = await createHouseholdTransaction(ada, {
        payee: "Corner Market",
        occurredOn: TODAY,
        accountId: account.value.id,
        amountCents: -2500,
        splits: [{ categoryId: groceries.id, amountCents: -2500 }],
      });
      assert.ok(typed.ok, JSON.stringify(typed));
      status = await statusOf(ada);
      assert.equal(done(status, "transactions"), true);

      // ---- (4) A budget counts once it is above zero. ----
      assert.ok((await setBudget(ada, { categoryId: groceries.id, month: { year: 2026, month: 10 }, amountCents: 0 })).ok);
      assert.equal(done(await statusOf(ada), "budget"), false, "a $0 budget is not a budget yet");
      assert.ok((await setBudget(ada, { categoryId: groceries.id, month: { year: 2026, month: 10 }, amountCents: 40000 })).ok);
      assert.equal(done(await statusOf(ada), "budget"), true);

      // ---- Skip for now, then resume: persisted, shared by members, progress kept. ----
      await owner`insert into household_member (household_id, user_id, role) values (${maple}, ${ids.ben}, 'member')`;
      const ben = { userId: ids.ben, householdId: maple };
      const skipped = await onboarding.dismissOnboarding(ada);
      assert.ok(skipped.ok);
      assert.equal(skipped.value.state, "dismissed");
      const benSees = await statusOf(ben);
      assert.equal(benSees.state, "dismissed", "skipping hides it for the whole household");
      assert.equal(benSees.requiredDone, skipped.value.requiredDone, "progress is kept while hidden");
      const [row] = await owner<{ dismissed_by_user_id: string }[]>`select dismissed_by_user_id from household_onboarding where household_id = ${maple}`;
      assert.equal(row.dismissed_by_user_id, ids.ada);
      const resumed = await onboarding.resumeOnboarding(ben);
      assert.ok(resumed.ok);
      assert.notEqual(resumed.value.state, "dismissed");
      assert.equal((await statusOf(ada)).state, resumed.value.state);

      // ---- (5) Invite: Ben joining (a second member) already counted it. ----
      status = await statusOf(ada);
      assert.equal(done(status, "invite"), true, "a second member completes the invite step");
      assert.equal(status.state, "complete", "the five required steps are done");
      assert.equal(status.nextStep, "recurring", "the optional step is still offered");

      // ---- (6) Optional recurring bill. ----
      const rent = await createRecurringItem(
        ada,
        { name: "Rent", payeeMatch: "maple property", amountCents: -150000, cadence: "monthly", anchorDate: "2026-10-01" },
        TODAY,
      );
      assert.ok(rent.ok, JSON.stringify(rent));
      status = await statusOf(ada);
      assert.equal(done(status, "recurring"), true);
      assert.equal(status.nextStep, null);

      // Steps stay done: archiving the only account does not undo step 1.
      assert.ok((await archiveHouseholdAccount(ada, account.value.id)).ok);
      assert.equal(done(await statusOf(ada), "account"), true);

      // ---- A second household: the invite path, and CSV import completing a step. ----
      const birchStarted = await startHousehold(ids.cy, `Birch ${stamp}`);
      assert.ok(birchStarted.ok);
      const birch = birchStarted.value.householdId;
      houses.push(birch);
      const cy = { userId: ids.cy, householdId: birch };
      const birchAccount = await addHouseholdAccount(cy, { name: "Card", type: "credit", opening: "0", owed: true });
      assert.ok(birchAccount.ok);
      const invited = await createHouseholdInvite(cy, `dot-${stamp}@onboarding.test`, {
        secret: "x".repeat(32),
        origin: "http://localhost:3000",
        mailMode: "local",
      });
      assert.ok(invited.ok, JSON.stringify(invited));
      assert.equal(done(await statusOf(cy), "invite"), true, "creating an invite completes the step");
      const csv = await commitCsvImport(cy, {
        csv: ["date,payee,amount", "2026-10-01,Gas Stop,-40.00", "2026-10-02,Book Nook,-12.00", "2026-10-03,Cafe,-5.00"].join("\n"),
        mapping: {
          hasHeader: true, dateColumn: 0, payeeColumn: 1, amountMode: "signed", amountColumn: 2, debitColumn: null, creditColumn: null,
          flipSign: false, dateOrder: null, accountMode: "fixed", accountColumn: null, fixedAccountId: birchAccount.value.id, categoryColumn: null, notesColumn: null,
        } satisfies ColumnMapping,
      });
      assert.ok(csv.ok && csv.value.added === 3, JSON.stringify(csv));
      const birchStatus = await statusOf(cy);
      assert.equal(done(birchStatus, "transactions"), true, "a CSV import completes the transactions step");
      assert.equal(done(birchStatus, "categories"), false, "the import's Uncategorized fallback does not set up categories");
      assert.equal(birchStatus.offerStarterCategories, true);

      // ---- RLS: Birch cannot read or change Maple's checklist. ----
      const peek = await withActor(ids.cy, (tx) => tx.select().from(householdOnboarding).where(eq(householdOnboarding.householdId, maple)));
      assert.deepEqual(peek, [], "another household's progress is invisible");
      const hijack = await onboarding.dismissOnboarding({ userId: ids.cy, householdId: maple });
      assert.equal(hijack.ok, false, "another household cannot skip it");
      const sneakStarter = await onboarding.addStarterCategories({ userId: ids.cy, householdId: maple });
      assert.equal(sneakStarter.ok, false, "or add categories to it");
      const [mapleRow] = await owner<{ dismissed_at: Date | null }[]>`select dismissed_at from household_onboarding where household_id = ${maple}`;
      assert.equal(mapleRow.dismissed_at, null);
      // The stamp function is not callable directly by the app role.
      await assert.rejects(
        withActor(ids.cy, (tx) => tx.execute(sql`select onboarding_mark(${maple}::uuid, 'budget')`)),
        (error: unknown) => /permission denied/.test(String((error as { cause?: { message?: string } }).cause?.message ?? error)),
      );
    } finally {
      for (const id of houses) await owner`delete from household where id = ${id}`;
      await owner`delete from "user" where id in ${owner([ids.ada, ids.ben, ids.cy, ids.dot])}`;
      await owner.end({ timeout: 5 });
      const { closeDb } = await import("../../db/client");
      await closeDb();
    }
  });
});
