// Local-only: realistic Jan-Oct 2026 data for the P&L screen (not committed).
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { loadEnv, requiredEnv } from "./env";
import { category, categoryBudget, categoryGroup, household, ledgerAccount, schema, transaction, transactionSplit } from "./schema";

const GROUPS: Array<[string, Array<[string, "income" | "expense", number | null, number]>]> = [
  ["Home", [["Rent", "expense", 1850, 1.0], ["Utilities", "expense", 240, 0.9], ["Internet and phone", "expense", 165, 1.0]]],
  ["Food", [["Groceries", "expense", 720, 0.93], ["Dining out", "expense", 260, 0.95], ["Coffee", "expense", 45, 0.9]]],
  ["Getting around", [["Gas", "expense", 180, 0.92], ["Transit", "expense", 60, 0.8], ["Car insurance", "expense", 142, 1.0]]],
  ["Fun", [["Streaming", "expense", 38, 1.0], ["Hobbies", "expense", 120, 0.85], ["Gifts", "expense", 100, 1.1]]],
  ["Health", [["Pharmacy", "expense", 55, 0.95], ["Vet visits", "expense", null, 0.0]]],
];

async function main() {
  loadEnv();
  const client = postgres(requiredEnv("DATABASE_MIGRATE_URL"), { max: 1 });
  const db = drizzle(client, { schema });
  const [house] = await db.select().from(household).where(eq(household.name, "Maple House"));
  if (!house) throw new Error("run db:seed first");
  await db.delete(transaction).where(eq(transaction.householdId, house.id));
  await db.delete(categoryBudget).where(eq(categoryBudget.householdId, house.id));
  await db.delete(category).where(eq(category.householdId, house.id));
  await db.delete(categoryGroup).where(eq(categoryGroup.householdId, house.id));
  const accts = await db.select().from(ledgerAccount).where(eq(ledgerAccount.householdId, house.id));
  const checking = accts.find((a) => a.name === "Checking")!;
  const visa = accts.find((a) => a.name === "Visa")!;

  const mk = async (groupId: string | null, name: string, kind: string, sortOrder: number) =>
    (await db.insert(category).values({ householdId: house.id, groupId, name, kind, sortOrder }).returning())[0];
  const incomeGroup = (await db.insert(categoryGroup).values({ householdId: house.id, name: "Income", sortOrder: 0 }).returning())[0];
  const incomes = [
    ["Paycheck, Kyle", 3100],
    ["Paycheck, Sam", 2350],
    ["Other income", 60],
  ] as const;
  const incomeCats = [];
  for (const [i, [name]] of incomes.entries()) incomeCats.push(await mk(incomeGroup.id, name, "income", i));
  const transfers = await mk(null, "Transfers", "transfer", 1000);

  type Row = { acct: string; on: string; payee: string; cents: number; cat: string };
  const rows: Row[] = [];
  const budgets: Array<typeof categoryBudget.$inferInsert> = [];
  const pad = (n: number) => String(n).padStart(2, "0");
  let salt = 0;
  for (const [gi, [gname, cats]] of GROUPS.entries()) {
    const g = (await db.insert(categoryGroup).values({ householdId: house.id, name: gname, sortOrder: gi + 1 }).returning())[0];
    for (const [ci, [name, kind, budget, factor]] of cats.entries()) {
      const c = await mk(g.id, name, kind, ci);
      salt += 1;
      for (let m = 1; m <= 10; m++) {
        if (budget !== null) budgets.push({ householdId: house.id, categoryId: c.id, year: 2026, month: m, amountCents: budget * 100 });
        let spend: number;
        if (budget === null) spend = m === 7 ? 310 : m === 10 ? 148 : 0;
        else {
          const wave = (m * 5 + salt * 3) % 7; // 0..6
          spend = Math.round(budget * (factor === 1.0 ? 1 : factor + (wave - 3) * 0.03));
          if (name === "Dining out" && m === 10) spend = 266; // already over the $260 budget
          if (m === 10 && name !== "Dining out") spend = Math.round(spend * 0.5);
        }
        if (spend > 0) rows.push({ acct: visa.id, on: `2026-${pad(m)}-${pad(m === 10 ? 9 : 6)}`, payee: `${name} merchant`, cents: -spend * 100, cat: c.id });
      }
    }
  }
  for (let m = 1; m <= 10; m++) {
    for (const [i, [, base]] of incomes.entries()) {
      const amt = base === 3100 && m === 7 ? 2000 : base;
      rows.push({ acct: checking.id, on: `2026-${pad(m)}-${pad(m === 10 ? 1 : 15)}`, payee: "Payroll", cents: amt * 100, cat: incomeCats[i].id });
    }
    // Card payment: transfers never count.
    rows.push({ acct: checking.id, on: `2026-${pad(m)}-${pad(m === 10 ? 10 : 20)}`, payee: "Visa payment", cents: -250000, cat: transfers.id });
    rows.push({ acct: visa.id, on: `2026-${pad(m)}-${pad(m === 10 ? 10 : 20)}`, payee: "Payment", cents: 250000, cat: transfers.id });
  }
  const coffee = (await db.select().from(category).where(and(eq(category.householdId, house.id), eq(category.name, "Coffee"))))[0];
  rows.push({ acct: visa.id, on: "2026-09-12", payee: "Coffee refund", cents: 1200, cat: coffee.id });

  await db.insert(categoryBudget).values(budgets);
  await db.transaction(async (tx) => {
    for (const r of rows) {
      const [t] = await tx.insert(transaction).values({ householdId: house.id, accountId: r.acct, occurredOn: r.on, payee: r.payee, amountCents: r.cents }).returning();
      await tx.insert(transactionSplit).values({ transactionId: t.id, householdId: house.id, categoryId: r.cat, amountCents: r.cents });
    }
  });
  console.log("seeded", rows.length, "transactions", budgets.length, "budgets");
  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
