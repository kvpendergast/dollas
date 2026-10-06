import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { withActor } from "@/db/actor";
import { migrateWithUrl } from "@/db/apply-migrations";
import { openAppDatabase } from "@/db/client";
import { PAYEE_RULE_NOT_IN_HOUSEHOLD } from "./payee-rule-plan";
import { applyPayeeRuleInTransaction, loadPayeeRuleApply, removePayeeRuleInTransaction } from "./payee-rule-store";

const OWNER_URL = "postgresql://dollas:dollas@127.0.0.1:5432/dollas";

type Sql = postgres.Sql;

type Books = {
  userA: string;
  userB: string;
  houseA: string;
  houseB: string;
  groceries: string;
  dining: string;
  householdGoods: string;
  diningB: string;
  ruleA: string;
  ruleB: string;
  changeId: string;
  caseId: string;
  alreadyId: string;
  deletedId: string;
  splitId: string;
  otherPayeeId: string;
  foreignId: string;
};

async function postgresReady(): Promise<boolean> {
  const probe = postgres(OWNER_URL, { max: 1, prepare: false, connect_timeout: 2, onnotice() {} });
  try {
    await probe`select 1`;
    return true;
  } catch (error) {
    if (process.env.CI) throw error;
    return false;
  } finally {
    await probe.end({ timeout: 1 }).catch(() => undefined);
  }
}

async function seed(owner: Sql): Promise<Books> {
  const userA = crypto.randomUUID();
  const userB = crypto.randomUUID();
  await owner`
    insert into "user" (id, name, email, email_verified)
    values
      (${userA}, 'Payee Ada', ${`${userA}@example.test`}, true),
      (${userB}, 'Payee Bea', ${`${userB}@example.test`}, true)
  `;
  const houses = await owner<{ id: string; name: string }[]>`
    insert into household (name, created_by)
    values ('Payee House A', ${userA}), ('Payee House B', ${userB})
    returning id, name
  `;
  const houseA = houses.find((row) => row.name === "Payee House A")?.id ?? "";
  const houseB = houses.find((row) => row.name === "Payee House B")?.id ?? "";
  await owner`
    insert into household_member (household_id, user_id, role)
    values (${houseA}, ${userA}, 'owner'), (${houseB}, ${userB}, 'owner')
  `;

  const accountA = await insertAccount(owner, houseA, "Checking A");
  const accountB = await insertAccount(owner, houseB, "Checking B");
  const groceries = await insertCategory(owner, houseA, "Groceries");
  const dining = await insertCategory(owner, houseA, "Dining out");
  const householdGoods = await insertCategory(owner, houseA, "Household");
  const diningB = await insertCategory(owner, houseB, "Dining out");

  const changeId = await insertTransaction(owner, {
    householdId: houseA,
    accountId: accountA,
    categoryId: dining,
    payee: "Corner Market",
    amountCents: -1_500,
  });
  const caseId = await insertTransaction(owner, {
    householdId: houseA,
    accountId: accountA,
    categoryId: dining,
    payee: "FARMERS MARKET",
    amountCents: -800,
  });
  const alreadyId = await insertTransaction(owner, {
    householdId: houseA,
    accountId: accountA,
    categoryId: groceries,
    payee: "Corner Market",
    amountCents: -2_000,
  });
  const deletedId = await insertTransaction(owner, {
    householdId: houseA,
    accountId: accountA,
    categoryId: dining,
    payee: "Corner Market",
    amountCents: -1_000,
    deleted: true,
  });
  const splitId = await insertSplitTransaction(owner, {
    householdId: houseA,
    accountId: accountA,
    payee: "Corner Market",
    parts: [
      { categoryId: dining, amountCents: -6_000 },
      { categoryId: householdGoods, amountCents: -2_640 },
    ],
  });
  const otherPayeeId = await insertTransaction(owner, {
    householdId: houseA,
    accountId: accountA,
    categoryId: dining,
    payee: "City utilities",
    amountCents: -4_000,
  });
  const foreignId = await insertTransaction(owner, {
    householdId: houseB,
    accountId: accountB,
    categoryId: diningB,
    payee: "Corner Market",
    amountCents: -1_500,
  });

  const [ruleARow] = await owner<{ id: string }[]>`
    insert into payee_category_rule (household_id, pattern, category_id)
    values (${houseA}, 'Market', ${groceries})
    returning id
  `;
  const [ruleBRow] = await owner<{ id: string }[]>`
    insert into payee_category_rule (household_id, pattern, category_id)
    values (${houseB}, 'Market', ${diningB})
    returning id
  `;

  return {
    userA,
    userB,
    houseA,
    houseB,
    groceries,
    dining,
    householdGoods,
    diningB,
    ruleA: ruleARow.id,
    ruleB: ruleBRow.id,
    changeId,
    caseId,
    alreadyId,
    deletedId,
    splitId,
    otherPayeeId,
    foreignId,
  };
}

async function insertAccount(owner: Sql, householdId: string, name: string): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    insert into ledger_account (household_id, name, type)
    values (${householdId}, ${name}, 'checking')
    returning id
  `;
  return row.id;
}

async function insertCategory(owner: Sql, householdId: string, name: string): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    insert into category (household_id, name, kind)
    values (${householdId}, ${name}, 'expense')
    returning id
  `;
  return row.id;
}

async function insertTransaction(
  owner: Sql,
  input: {
    householdId: string;
    accountId: string;
    categoryId: string;
    payee: string;
    amountCents: number;
    deleted?: boolean;
  },
): Promise<string> {
  const [created] = await owner.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into transaction (household_id, account_id, occurred_on, payee, amount_cents, deleted_at)
      values (
        ${input.householdId},
        ${input.accountId},
        '2026-03-02',
        ${input.payee},
        ${input.amountCents},
        case when ${Boolean(input.deleted)} then now() else null end
      )
      returning id
    `;
    await tx`
      insert into transaction_split (transaction_id, household_id, category_id, amount_cents)
      values (${row.id}, ${input.householdId}, ${input.categoryId}, ${input.amountCents})
    `;
    return [row];
  });
  return created.id;
}

async function insertSplitTransaction(
  owner: Sql,
  input: {
    householdId: string;
    accountId: string;
    payee: string;
    parts: { categoryId: string; amountCents: number }[];
  },
): Promise<string> {
  const amountCents = input.parts.reduce((sum, part) => sum + part.amountCents, 0);
  const [created] = await owner.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into transaction (household_id, account_id, occurred_on, payee, amount_cents)
      values (${input.householdId}, ${input.accountId}, '2026-03-03', ${input.payee}, ${amountCents})
      returning id
    `;
    for (const part of input.parts) {
      await tx`
        insert into transaction_split (transaction_id, household_id, category_id, amount_cents)
        values (${row.id}, ${input.householdId}, ${part.categoryId}, ${part.amountCents})
      `;
    }
    return [row];
  });
  return created.id;
}

async function categoriesFor(owner: Sql, transactionId: string): Promise<string[]> {
  const rows = await owner<{ category_id: string }[]>`
    select category_id from transaction_split where transaction_id = ${transactionId} order by amount_cents
  `;
  return rows.map((row) => row.category_id);
}

describe("payee rule apply in the database", () => {
  it("counts matches, applies them in one household transaction, and removes only that rule", async (ctx) => {
    if (!(await postgresReady())) {
      ctx.skip();
      return;
    }

    await migrateWithUrl(OWNER_URL);
    const owner = postgres(OWNER_URL, { max: 1, prepare: false, onnotice() {} });
    const app = openAppDatabase(OWNER_URL, 1);
    let seeded: Books | undefined;
    try {
      const fixture = await seed(owner);
      seeded = fixture;
      const preview = await withActor(
        fixture.userA,
        (tx) => loadPayeeRuleApply(tx, fixture.houseA, fixture.ruleA),
        app.db,
      );
      expect(preview.pattern).toBe("Market");
      expect(preview.categoryName).toBe("Groceries");
      expect(new Set(preview.plan.changeIds)).toEqual(new Set([fixture.changeId, fixture.caseId]));
      expect(preview.plan.skippedSplitIds).toEqual([fixture.splitId]);
      expect(preview.plan.skippedWithoutCategoryIds).toEqual([]);
      expect(preview.plan.changeIds).not.toContain(fixture.deletedId);
      expect(preview.plan.changeIds).not.toContain(fixture.foreignId);

      const applied = await withActor(
        fixture.userA,
        (tx) => applyPayeeRuleInTransaction(tx, fixture.houseA, fixture.ruleA),
        app.db,
      );
      expect(new Set(applied.plan.changeIds)).toEqual(new Set([fixture.changeId, fixture.caseId]));
      expect(await categoriesFor(owner, fixture.changeId)).toEqual([fixture.groceries]);
      expect(await categoriesFor(owner, fixture.caseId)).toEqual([fixture.groceries]);
      expect(await categoriesFor(owner, fixture.alreadyId)).toEqual([fixture.groceries]);
      expect(await categoriesFor(owner, fixture.deletedId)).toEqual([fixture.dining]);
      expect(new Set(await categoriesFor(owner, fixture.splitId))).toEqual(new Set([fixture.dining, fixture.householdGoods]));
      expect(await categoriesFor(owner, fixture.otherPayeeId)).toEqual([fixture.dining]);
      expect(await categoriesFor(owner, fixture.foreignId)).toEqual([fixture.diningB]);
      const [deleted] = await owner<{ deleted: boolean }[]>`
        select deleted_at is not null as deleted from transaction where id = ${fixture.deletedId}
      `;
      expect(deleted.deleted).toBe(true);

      const again = await withActor(
        fixture.userA,
        (tx) => loadPayeeRuleApply(tx, fixture.houseA, fixture.ruleA),
        app.db,
      );
      expect(again.plan.changeIds).toEqual([]);
      expect(again.plan.skippedSplitIds).toEqual([fixture.splitId]);

      await expect(
        withActor(fixture.userA, (tx) => applyPayeeRuleInTransaction(tx, fixture.houseA, fixture.ruleB), app.db),
      ).rejects.toThrow(PAYEE_RULE_NOT_IN_HOUSEHOLD);
      expect(await categoriesFor(owner, fixture.foreignId)).toEqual([fixture.diningB]);

      const removed = await withActor(
        fixture.userA,
        (tx) => removePayeeRuleInTransaction(tx, fixture.houseA, fixture.ruleA),
        app.db,
      );
      expect(removed.pattern).toBe("Market");
      await expect(
        withActor(fixture.userA, (tx) => removePayeeRuleInTransaction(tx, fixture.houseA, fixture.ruleB), app.db),
      ).rejects.toThrow(PAYEE_RULE_NOT_IN_HOUSEHOLD);
      await expect(
        withActor(fixture.userA, (tx) => removePayeeRuleInTransaction(tx, fixture.houseB, fixture.ruleB), app.db),
      ).rejects.toThrow(PAYEE_RULE_NOT_IN_HOUSEHOLD);
      const remaining = await owner<{ id: string }[]>`
        select id from payee_category_rule where id in (${fixture.ruleA}, ${fixture.ruleB})
      `;
      expect(remaining.map((row) => row.id)).toEqual([fixture.ruleB]);
    } finally {
      if (seeded) {
        await owner`delete from household where id in (${seeded.houseA}, ${seeded.houseB})`.catch(() => undefined);
        await owner`delete from "user" where id in (${seeded.userA}, ${seeded.userB})`.catch(() => undefined);
      }
      await app.close().catch(() => undefined);
      await owner.end({ timeout: 5 }).catch(() => undefined);
    }
  }, 60_000);
});
