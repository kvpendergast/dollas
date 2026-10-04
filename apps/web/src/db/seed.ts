import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { civilDateInTimeZone, toIsoDate, type CivilDate } from "@dollas/domain";
import { loadEnv, requiredEnv } from "./env";
import {
  account,
  category,
  categoryBudget,
  household,
  householdInvite,
  householdMember,
  ledgerAccount,
  schema,
  transaction,
  transactionSplit,
  user,
} from "./schema";

const DEMO_EMAIL = "ada@maple.local";
const DEMO_PASSWORD = "maple-demo";
const DEMO_NAME = "Ada Maple";
const HOUSEHOLD_NAME = "Maple House";
const INVITE_CODE = "MAPLE-HOUSE";

type ExpensePlan = {
  key: string;
  name: string;
  baseCents: number;
  budgetCents: number;
  salt: number;
};

const EXPENSES: ExpensePlan[] = [
  { key: "rent", name: "Rent", baseCents: 180_000, budgetCents: 180_000, salt: 1 },
  { key: "groceries", name: "Groceries", baseCents: 64_000, budgetCents: 48_000, salt: 2 },
  { key: "transit", name: "Transit", baseCents: 14_000, budgetCents: 18_000, salt: 3 },
  { key: "dining", name: "Dining out", baseCents: 32_000, budgetCents: 36_000, salt: 4 },
  { key: "utilities", name: "Utilities", baseCents: 16_500, budgetCents: 12_000, salt: 5 },
  { key: "household", name: "Household", baseCents: 18_000, budgetCents: 22_000, salt: 6 },
];

function vary(base: number, year: number, month: number, salt: number): number {
  const wave = ((year * 12 + month) * (salt + 3) + salt * 13) % 11;
  return base + (wave - 5) * Math.round(base * 0.035);
}

function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function onOrBefore(date: CivilDate, asOf: CivilDate): boolean {
  return toIsoDate(date) <= toIsoDate(asOf);
}

async function main() {
  loadEnv();
  const url = requiredEnv("DATABASE_MIGRATE_URL");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });
  const asOf = civilDateInTimeZone(new Date(), "UTC");
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  let [demo] = await db.select().from(user).where(eq(user.email, DEMO_EMAIL));
  if (!demo) {
    const userId = crypto.randomUUID();
    await db.insert(user).values({
      id: userId,
      name: DEMO_NAME,
      email: DEMO_EMAIL,
      emailVerified: true,
    });
    await db.insert(account).values({
      id: crypto.randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: passwordHash,
    });
    demo = (await db.select().from(user).where(eq(user.id, userId)))[0];
  }

  const owned = await db.select().from(household).where(eq(household.createdBy, demo.id));
  for (const row of owned) {
    await db.delete(household).where(eq(household.id, row.id));
  }

  const [house] = await db
    .insert(household)
    .values({ name: HOUSEHOLD_NAME, createdBy: demo.id, timezone: "UTC", currency: "USD" })
    .returning();
  await db.insert(householdMember).values({
    householdId: house.id,
    userId: demo.id,
    role: "owner",
  });
  await db.insert(householdInvite).values({
    householdId: house.id,
    code: INVITE_CODE,
    createdBy: demo.id,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
  });

  const [checking, , visa] = await db
    .insert(ledgerAccount)
    .values([
      { householdId: house.id, name: "Checking", type: "checking", openingBalanceCents: 245_000 },
      { householdId: house.id, name: "Savings", type: "savings", openingBalanceCents: 820_000 },
      { householdId: house.id, name: "Visa", type: "credit", openingBalanceCents: 0 },
    ])
    .returning();

  const [paycheck, ...expenseRows] = await db
    .insert(category)
    .values([
      { householdId: house.id, name: "Paycheck", kind: "income", sortOrder: 0 },
      ...EXPENSES.map((item, index) => ({
        householdId: house.id,
        name: item.name,
        kind: "expense" as const,
        sortOrder: index + 1,
      })),
    ])
    .returning();
  const expenseByKey = new Map(EXPENSES.map((item, index) => [item.key, expenseRows[index]]));

  const budgets: Array<typeof categoryBudget.$inferInsert> = [];
  for (let offset = -14; offset <= 0; offset += 1) {
    const cursor = shiftMonth(asOf.year, asOf.month, offset);
    for (const item of EXPENSES) {
      const row = expenseByKey.get(item.key);
      if (!row) continue;
      budgets.push({
        householdId: house.id,
        categoryId: row.id,
        year: cursor.year,
        month: cursor.month,
        amountCents: item.budgetCents,
      });
    }
  }
  await db.insert(categoryBudget).values(budgets);

  type Draft = {
    accountId: string;
    occurredOn: string;
    payee: string;
    amountCents: number;
    splits: Array<{ categoryId: string; amountCents: number }>;
  };
  const drafts: Draft[] = [];

  for (let offset = -26; offset <= 0; offset += 1) {
    const cursor = shiftMonth(asOf.year, asOf.month, offset);
    const monthLength = daysInMonth(cursor.year, cursor.month);
    const push = (day: number, draft: Omit<Draft, "occurredOn">) => {
      if (day > monthLength) return;
      const date = { year: cursor.year, month: cursor.month, day };
      if (!onOrBefore(date, asOf)) return;
      drafts.push({ ...draft, occurredOn: toIsoDate(date) });
    };
    const rent = expenseByKey.get("rent");
    const groceries = expenseByKey.get("groceries");
    const householdGoods = expenseByKey.get("household");
    const transit = expenseByKey.get("transit");
    const dining = expenseByKey.get("dining");
    const utilities = expenseByKey.get("utilities");
    if (!rent || !groceries || !householdGoods || !transit || !dining || !utilities) continue;

    const paycheckAmount = vary(320_000, cursor.year, cursor.month, 8);
    push(1, {
      accountId: checking.id,
      payee: "Northwind Payroll",
      amountCents: paycheckAmount,
      splits: [{ categoryId: paycheck.id, amountCents: paycheckAmount }],
    });
    push(15, {
      accountId: checking.id,
      payee: "Northwind Payroll",
      amountCents: paycheckAmount,
      splits: [{ categoryId: paycheck.id, amountCents: paycheckAmount }],
    });

    const rentAmount = -vary(180_000, cursor.year, cursor.month, 1);
    push(1, {
      accountId: checking.id,
      payee: "Maple Rent",
      amountCents: rentAmount,
      splits: [{ categoryId: rent.id, amountCents: rentAmount }],
    });

    const market = -vary(28_000, cursor.year, cursor.month, 2);
    const goods = -vary(12_000, cursor.year, cursor.month, 6);
    push(3, {
      accountId: visa.id,
      payee: "Corner Market",
      amountCents: market + goods,
      splits: [
        { categoryId: groceries.id, amountCents: market },
        { categoryId: householdGoods.id, amountCents: goods },
      ],
    });

    for (const day of [10, 17, 24]) {
      const amount = -Math.round(vary(64_000, cursor.year, cursor.month, 2) / 4);
      push(day, {
        accountId: visa.id,
        payee: day === 17 ? "Farmers market" : "Corner Market",
        amountCents: amount,
        splits: [{ categoryId: groceries.id, amountCents: amount }],
      });
    }

    const transitAmount = -vary(14_000, cursor.year, cursor.month, 3);
    push(5, {
      accountId: checking.id,
      payee: "City transit",
      amountCents: transitAmount,
      splits: [{ categoryId: transit.id, amountCents: transitAmount }],
    });

    for (const day of [8, 22]) {
      const amount = -Math.round(vary(32_000, cursor.year, cursor.month, 4) / 2);
      push(day, {
        accountId: visa.id,
        payee: day === 8 ? "Lunch counter" : "Weeknight dinner",
        amountCents: amount,
        splits: [{ categoryId: dining.id, amountCents: amount }],
      });
    }

    const utilityAmount = -vary(16_500, cursor.year, cursor.month, 5);
    push(4, {
      accountId: checking.id,
      payee: "City utilities",
      amountCents: utilityAmount,
      splits: [{ categoryId: utilities.id, amountCents: utilityAmount }],
    });
  }

  await db.transaction(async (tx) => {
    for (const draft of drafts) {
      const [row] = await tx
        .insert(transaction)
        .values({
          householdId: house.id,
          accountId: draft.accountId,
          occurredOn: draft.occurredOn,
          payee: draft.payee,
          amountCents: draft.amountCents,
        })
        .returning();
      await tx.insert(transactionSplit).values(
        draft.splits.map((split) => ({
          transactionId: row.id,
          householdId: house.id,
          categoryId: split.categoryId,
          amountCents: split.amountCents,
        })),
      );
    }
  });

  const currentGroceries = expenseByKey.get("groceries");
  if (currentGroceries) {
    await db
      .update(categoryBudget)
      .set({ amountCents: 48_000 })
      .where(
        and(
          eq(categoryBudget.categoryId, currentGroceries.id),
          eq(categoryBudget.year, asOf.year),
          eq(categoryBudget.month, asOf.month),
        ),
      );
  }

  console.log(`Seeded ${HOUSEHOLD_NAME} for ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`Invite code ${INVITE_CODE}`);
  console.log(`Transactions ${drafts.length}, as of ${toIsoDate(asOf)}`);
  await client.end();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
