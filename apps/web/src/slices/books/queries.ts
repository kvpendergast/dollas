import {
  buildSpendingHistory,
  estimateMonthSpend,
  expenseMagnitude,
  incomeMagnitude,
  summarizeCategoryMonth,
  toIsoDate,
  type CivilDate,
  type HistoryColumn,
  type SpendEstimate,
} from "@dollas/domain";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { withActor } from "@/db/actor";
import {
  category,
  categoryBudget,
  householdInvite,
  ledgerAccount,
  transaction,
  transactionSplit,
} from "@/db/schema";
import type { BooksContext } from "@/slices/access/guard";

function monthStart(asOf: CivilDate): string {
  return toIsoDate({ year: asOf.year, month: asOf.month, day: 1 });
}

export async function loadHome(books: BooksContext) {
  const start = monthStart(books.asOf);
  const end = toIsoDate(books.asOf);
  const rows = await withActor(books.userId, async (tx) => {
    const transactions = await tx
      .select({
        id: transaction.id,
        amountCents: transaction.amountCents,
        categoryId: transactionSplit.categoryId,
        categoryName: category.name,
        splitCents: transactionSplit.amountCents,
        kind: category.kind,
      })
      .from(transaction)
      .innerJoin(transactionSplit, eq(transactionSplit.transactionId, transaction.id))
      .innerJoin(category, eq(category.id, transactionSplit.categoryId))
      .where(
        and(
          eq(transaction.householdId, books.householdId),
          gte(transaction.occurredOn, start),
          lte(transaction.occurredOn, end),
        ),
      );
    const budgets = await tx
      .select({
        categoryId: categoryBudget.categoryId,
        amountCents: categoryBudget.amountCents,
      })
      .from(categoryBudget)
      .where(
        and(
          eq(categoryBudget.householdId, books.householdId),
          eq(categoryBudget.year, books.asOf.year),
          eq(categoryBudget.month, books.asOf.month),
        ),
      );
    const [account] = await tx
      .select({ id: ledgerAccount.id })
      .from(ledgerAccount)
      .where(eq(ledgerAccount.householdId, books.householdId))
      .limit(1);
    return { transactions, budgets, hasAccounts: Boolean(account) };
  });

  const seen = new Set<string>();
  let incomeCents = 0;
  let spentCents = 0;
  for (const row of rows.transactions) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    incomeCents += incomeMagnitude(row.amountCents);
    spentCents += expenseMagnitude(row.amountCents);
  }
  const spentByCategory = new Map<string, { name: string; spentCents: number }>();
  for (const row of rows.transactions) {
    if (row.splitCents >= 0) continue;
    const current = spentByCategory.get(row.categoryId) ?? { name: row.categoryName, spentCents: 0 };
    current.spentCents += -row.splitCents;
    spentByCategory.set(row.categoryId, current);
  }
  const budgetByCategory = new Map(rows.budgets.map((row) => [row.categoryId, row.amountCents]));
  const categories = [...spentByCategory.entries()]
    .map(([categoryId, value]) =>
      summarizeCategoryMonth({
        categoryId,
        name: value.name,
        spentCents: value.spentCents,
        budgetCents: budgetByCategory.get(categoryId) ?? null,
      }),
    )
    .sort((a, b) => b.spentCents - a.spentCents);
  const budgetedCents = rows.budgets.reduce((sum, row) => sum + row.amountCents, 0);
  const estimateResult = estimateMonthSpend({ spentSoFarCents: spentCents, asOf: books.asOf });
  if (estimateResult.isErr()) throw estimateResult.error;
  return {
    incomeCents,
    spentCents,
    leftCents: incomeCents - spentCents,
    budgetedCents,
    categories: categories.slice(0, 5),
    hasAccounts: rows.hasAccounts,
    estimate: estimateResult.value satisfies SpendEstimate,
  };
}

export async function loadActivity(books: BooksContext) {
  return withActor(books.userId, async (tx) => {
    const accounts = await tx
      .select()
      .from(ledgerAccount)
      .where(eq(ledgerAccount.householdId, books.householdId));
    const categories = await tx
      .select()
      .from(category)
      .where(eq(category.householdId, books.householdId));
    const rows = await tx
      .select({
        id: transaction.id,
        occurredOn: transaction.occurredOn,
        payee: transaction.payee,
        amountCents: transaction.amountCents,
        accountId: transaction.accountId,
        accountName: ledgerAccount.name,
        categoryId: category.id,
        categoryName: category.name,
        splitCents: transactionSplit.amountCents,
      })
      .from(transaction)
      .innerJoin(ledgerAccount, eq(ledgerAccount.id, transaction.accountId))
      .innerJoin(transactionSplit, eq(transactionSplit.transactionId, transaction.id))
      .innerJoin(category, eq(category.id, transactionSplit.categoryId))
      .where(eq(transaction.householdId, books.householdId));
    const grouped = new Map<
      string,
      {
        id: string;
        occurredOn: string;
        payee: string;
        amountCents: number;
        accountId: string;
        accountName: string;
        splits: Array<{ categoryId: string; categoryName: string; amountCents: number }>;
      }
    >();
    for (const row of rows) {
      const current = grouped.get(row.id) ?? {
        id: row.id,
        occurredOn: row.occurredOn,
        payee: row.payee,
        amountCents: row.amountCents,
        accountId: row.accountId,
        accountName: row.accountName,
        splits: [],
      };
      current.splits.push({
        categoryId: row.categoryId,
        categoryName: row.categoryName,
        amountCents: row.splitCents,
      });
      grouped.set(row.id, current);
    }
    const transactions = [...grouped.values()].sort((a, b) => {
      if (a.occurredOn === b.occurredOn) return a.payee.localeCompare(b.payee);
      return a.occurredOn < b.occurredOn ? 1 : -1;
    });
    return {
      accounts: accounts.sort((a, b) => a.name.localeCompare(b.name)),
      categories: categories.sort((a, b) => a.sortOrder - b.sortOrder),
      transactions: transactions.slice(0, 60),
    };
  });
}

export async function loadAccounts(books: BooksContext) {
  return withActor(books.userId, async (tx) => {
    const accounts = await tx
      .select()
      .from(ledgerAccount)
      .where(eq(ledgerAccount.householdId, books.householdId));
    const movements = await tx
      .select({ accountId: transaction.accountId, amountCents: transaction.amountCents })
      .from(transaction)
      .where(eq(transaction.householdId, books.householdId));
    const sums = new Map<string, number>();
    for (const row of movements) sums.set(row.accountId, (sums.get(row.accountId) ?? 0) + row.amountCents);
    return accounts
      .map((account) => ({
        ...account,
        balanceCents: account.openingBalanceCents + (sums.get(account.id) ?? 0),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

export async function loadPlan(books: BooksContext) {
  const start = monthStart(books.asOf);
  const end = toIsoDate(books.asOf);
  return withActor(books.userId, async (tx) => {
    const categories = await tx.select().from(category).where(eq(category.householdId, books.householdId));
    const budgets = await tx
      .select()
      .from(categoryBudget)
      .where(
        and(
          eq(categoryBudget.householdId, books.householdId),
          eq(categoryBudget.year, books.asOf.year),
          eq(categoryBudget.month, books.asOf.month),
        ),
      );
    const splits = await tx
      .select({
        categoryId: transactionSplit.categoryId,
        amountCents: transactionSplit.amountCents,
      })
      .from(transactionSplit)
      .innerJoin(transaction, eq(transaction.id, transactionSplit.transactionId))
      .where(
        and(
          eq(transaction.householdId, books.householdId),
          gte(transaction.occurredOn, start),
          lte(transaction.occurredOn, end),
        ),
      );
    const spent = new Map<string, number>();
    for (const split of splits) {
      if (split.amountCents >= 0) continue;
      spent.set(split.categoryId, (spent.get(split.categoryId) ?? 0) + -split.amountCents);
    }
    const budgetByCategory = new Map(budgets.map((row) => [row.categoryId, row.amountCents]));
    const expense = categories
      .filter((row) => row.kind === "expense")
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((row) =>
        summarizeCategoryMonth({
          categoryId: row.id,
          name: row.name,
          spentCents: spent.get(row.id) ?? 0,
          budgetCents: budgetByCategory.get(row.id) ?? null,
        }),
      );
    const incomeCents = splits.filter((split) => split.amountCents > 0).reduce((sum, split) => sum + split.amountCents, 0);
    return { expense, incomeCents };
  });
}

export async function loadHistory(books: BooksContext): Promise<HistoryColumn[]> {
  const rows = await withActor(books.userId, (tx) =>
    tx
      .select({ occurredOn: transaction.occurredOn, amountCents: transaction.amountCents })
      .from(transaction)
      .where(eq(transaction.householdId, books.householdId)),
  );
  const expenses = rows
    .filter((row) => row.amountCents < 0)
    .map((row) => ({ occurredOn: row.occurredOn, spentCents: -row.amountCents }));
  const history = buildSpendingHistory({ expenses, asOf: books.asOf, monthCount: 12 });
  if (history.isErr()) throw history.error;
  return history.value;
}

export async function loadProjection(books: BooksContext) {
  const home = await loadHome(books);
  return home.estimate;
}

export async function loadInvites(books: BooksContext) {
  return withActor(books.userId, (tx) =>
    tx
      .select()
      .from(householdInvite)
      .where(and(eq(householdInvite.householdId, books.householdId), sql`${householdInvite.expiresAt} > now()`)),
  );
}
