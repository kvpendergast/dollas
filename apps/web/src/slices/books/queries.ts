import {
  accountBalanceCents,
  accountsForActiveLists,
  buildSpendingHistory,
  categoryBooksEffect,
  estimateMonthSpend,
  homeAccountTotalCents,
  isAccountType,
  summarizeCategoryMonth,
  toIsoDate,
  type AccountType,
  type CivilDate,
  type HistoryColumn,
  type SpendEstimate,
} from "@dollas/domain";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { withActor } from "@/db/actor";
import {
  category,
  categoryBudget,
  categoryGroup,
  householdInvite,
  ledgerAccount,
  payeeCategoryRule,
  transaction,
  transactionSplit,
} from "@/db/schema";
import type { BooksContext } from "@/slices/access/guard";

function monthStart(asOf: CivilDate): string {
  return toIsoDate({ year: asOf.year, month: asOf.month, day: 1 });
}

function effectOf(kind: string, amountCents: number) {
  const effect = categoryBooksEffect(kind, amountCents);
  if (effect.isErr()) throw effect.error;
  return effect.value;
}

function categoryLabel(name: string, groupName: string | null): string {
  return groupName ? `${groupName} · ${name}` : name;
}

type ListedCategory = {
  id: string;
  name: string;
  kind: string;
  sortOrder: number;
  groupId: string | null;
  groupName: string | null;
  groupSort: number | null;
};

function compareListed(a: ListedCategory, b: ListedCategory): number {
  const aGroup = a.groupSort ?? Number.MAX_SAFE_INTEGER;
  const bGroup = b.groupSort ?? Number.MAX_SAFE_INTEGER;
  if (aGroup !== bGroup) return aGroup - bGroup;
  const groupName = (a.groupName ?? "").localeCompare(b.groupName ?? "");
  if (groupName !== 0) return groupName;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.name.localeCompare(b.name);
}

export async function loadHome(books: BooksContext) {
  const start = monthStart(books.asOf);
  const end = toIsoDate(books.asOf);
  const rows = await withActor(books.userId, async (tx) => {
    const transactions = await tx
      .select({
        categoryId: transactionSplit.categoryId,
        categoryName: category.name,
        groupName: categoryGroup.name,
        splitCents: transactionSplit.amountCents,
        kind: category.kind,
      })
      .from(transaction)
      .innerJoin(transactionSplit, eq(transactionSplit.transactionId, transaction.id))
      .innerJoin(category, eq(category.id, transactionSplit.categoryId))
      .leftJoin(categoryGroup, eq(categoryGroup.id, category.groupId))
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
    const accountRows = await tx
      .select({
        id: ledgerAccount.id,
        householdId: ledgerAccount.householdId,
        name: ledgerAccount.name,
        type: ledgerAccount.type,
        openingBalanceCents: ledgerAccount.openingBalanceCents,
        archivedAt: ledgerAccount.archivedAt,
      })
      .from(ledgerAccount)
      .where(eq(ledgerAccount.householdId, books.householdId));
    const accountMovements = await tx
      .select({ accountId: transaction.accountId, amountCents: transaction.amountCents })
      .from(transaction)
      .where(eq(transaction.householdId, books.householdId));
    return { transactions, budgets, accountRows, accountMovements };
  });
  const accounts = rollupAccounts(rows.accountRows, rows.accountMovements);
  const accountTotal = homeAccountTotalCents(accounts, books.householdId);
  if (accountTotal.isErr()) throw accountTotal.error;

  let incomeCents = 0;
  let spentCents = 0;
  const spentByCategory = new Map<string, { name: string; spentCents: number }>();
  for (const row of rows.transactions) {
    const effect = effectOf(row.kind, row.splitCents);
    incomeCents += effect.incomeCents;
    spentCents += effect.spentCents;
    if (effect.spentCents === 0) continue;
    const current = spentByCategory.get(row.categoryId) ?? {
      name: categoryLabel(row.categoryName, row.groupName),
      spentCents: 0,
    };
    current.spentCents += effect.spentCents;
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
    hasAccounts: accountsForActiveLists(accounts, books.householdId).length > 0,
    accountBalanceCents: accountTotal.value,
    estimate: estimateResult.value satisfies SpendEstimate,
  };
}

export async function loadActivity(books: BooksContext) {
  return withActor(books.userId, async (tx) => {
    const accounts = await tx
      .select()
      .from(ledgerAccount)
      .where(eq(ledgerAccount.householdId, books.householdId));
    const categories = (
      await tx
        .select({
          id: category.id,
          name: category.name,
          kind: category.kind,
          sortOrder: category.sortOrder,
          groupId: category.groupId,
          groupName: categoryGroup.name,
          groupSort: categoryGroup.sortOrder,
        })
        .from(category)
        .leftJoin(categoryGroup, eq(categoryGroup.id, category.groupId))
        .where(eq(category.householdId, books.householdId))
    ).sort(compareListed);
    const rows = await tx
      .select({
        id: transaction.id,
        occurredOn: transaction.occurredOn,
        payee: transaction.payee,
        amountCents: transaction.amountCents,
        accountId: transaction.accountId,
        accountName: ledgerAccount.name,
        accountArchivedAt: ledgerAccount.archivedAt,
        categoryId: category.id,
        categoryName: category.name,
        groupName: categoryGroup.name,
        splitCents: transactionSplit.amountCents,
      })
      .from(transaction)
      .innerJoin(ledgerAccount, eq(ledgerAccount.id, transaction.accountId))
      .innerJoin(transactionSplit, eq(transactionSplit.transactionId, transaction.id))
      .innerJoin(category, eq(category.id, transactionSplit.categoryId))
      .leftJoin(categoryGroup, eq(categoryGroup.id, category.groupId))
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
        accountArchived: boolean;
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
        accountArchived: row.accountArchivedAt !== null,
        splits: [],
      };
      current.splits.push({
        categoryId: row.categoryId,
        categoryName: categoryLabel(row.categoryName, row.groupName),
        amountCents: row.splitCents,
      });
      grouped.set(row.id, current);
    }
    const transactions = [...grouped.values()].sort((a, b) => {
      if (a.occurredOn === b.occurredOn) return a.payee.localeCompare(b.payee);
      return a.occurredOn < b.occurredOn ? 1 : -1;
    });
    const rules = await tx
      .select({
        id: payeeCategoryRule.id,
        pattern: payeeCategoryRule.pattern,
        categoryId: payeeCategoryRule.categoryId,
        categoryName: category.name,
        groupName: categoryGroup.name,
      })
      .from(payeeCategoryRule)
      .innerJoin(category, eq(category.id, payeeCategoryRule.categoryId))
      .leftJoin(categoryGroup, eq(categoryGroup.id, category.groupId))
      .where(eq(payeeCategoryRule.householdId, books.householdId));
    return {
      accounts: accounts
        .flatMap((account) => {
          if (!isAccountType(account.type)) return [];
          return [
            {
              id: account.id,
              name: account.name,
              householdId: account.householdId,
              type: account.type,
              archivedAt: account.archivedAt ? account.archivedAt.toISOString() : null,
            },
          ];
        })
        .sort((a, b) => a.name.localeCompare(b.name)),
      categories,
      payeeRules: rules
        .map((rule) => ({
          id: rule.id,
          pattern: rule.pattern,
          categoryId: rule.categoryId,
          categoryName: categoryLabel(rule.categoryName, rule.groupName),
        }))
        .sort((a, b) => a.pattern.localeCompare(b.pattern)),
      transactions: transactions.slice(0, 60),
    };
  });
}

export type AccountListItem = {
  id: string;
  householdId: string;
  name: string;
  type: AccountType;
  openingBalanceCents: number;
  archivedAt: string | null;
  movementCents: number;
  transactionCount: number;
  balanceCents: number;
};

function rollupAccounts(
  rows: Array<{
    id: string;
    householdId: string;
    name: string;
    type: string;
    openingBalanceCents: number;
    archivedAt: Date | null;
  }>,
  movements: Array<{ accountId: string; amountCents: number }>,
): AccountListItem[] {
  const sums = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const row of movements) {
    sums.set(row.accountId, (sums.get(row.accountId) ?? 0) + row.amountCents);
    counts.set(row.accountId, (counts.get(row.accountId) ?? 0) + 1);
  }
  return rows
    .flatMap((account) => {
      if (!isAccountType(account.type)) return [];
      const movementCents = sums.get(account.id) ?? 0;
      const balance = accountBalanceCents({
        openingBalanceCents: account.openingBalanceCents,
        movementCents,
      });
      if (balance.isErr()) throw balance.error;
      return [
        {
          id: account.id,
          householdId: account.householdId,
          name: account.name,
          type: account.type,
          openingBalanceCents: account.openingBalanceCents,
          archivedAt: account.archivedAt ? account.archivedAt.toISOString() : null,
          movementCents,
          transactionCount: counts.get(account.id) ?? 0,
          balanceCents: balance.value,
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadAccounts(books: BooksContext) {
  return withActor(books.userId, async (tx) => {
    const accounts = await tx
      .select({
        id: ledgerAccount.id,
        householdId: ledgerAccount.householdId,
        name: ledgerAccount.name,
        type: ledgerAccount.type,
        openingBalanceCents: ledgerAccount.openingBalanceCents,
        archivedAt: ledgerAccount.archivedAt,
      })
      .from(ledgerAccount)
      .where(eq(ledgerAccount.householdId, books.householdId));
    const movements = await tx
      .select({ accountId: transaction.accountId, amountCents: transaction.amountCents })
      .from(transaction)
      .where(eq(transaction.householdId, books.householdId));
    return rollupAccounts(accounts, movements);
  });
}

export async function loadPlan(books: BooksContext) {
  const start = monthStart(books.asOf);
  const end = toIsoDate(books.asOf);
  return withActor(books.userId, async (tx) => {
    const categories = (
      await tx
        .select({
          id: category.id,
          name: category.name,
          kind: category.kind,
          sortOrder: category.sortOrder,
          groupId: category.groupId,
          groupName: categoryGroup.name,
          groupSort: categoryGroup.sortOrder,
        })
        .from(category)
        .leftJoin(categoryGroup, eq(categoryGroup.id, category.groupId))
        .where(eq(category.householdId, books.householdId))
    ).sort(compareListed);
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
        kind: category.kind,
      })
      .from(transactionSplit)
      .innerJoin(transaction, eq(transaction.id, transactionSplit.transactionId))
      .innerJoin(category, eq(category.id, transactionSplit.categoryId))
      .where(
        and(
          eq(transaction.householdId, books.householdId),
          gte(transaction.occurredOn, start),
          lte(transaction.occurredOn, end),
        ),
      );
    const spent = new Map<string, number>();
    let incomeCents = 0;
    for (const split of splits) {
      const effect = effectOf(split.kind, split.amountCents);
      incomeCents += effect.incomeCents;
      if (effect.spentCents === 0) continue;
      spent.set(split.categoryId, (spent.get(split.categoryId) ?? 0) + effect.spentCents);
    }
    const budgetByCategory = new Map(budgets.map((row) => [row.categoryId, row.amountCents]));
    const expense = categories
      .filter((row) => row.kind === "expense")
      .map((row) => ({
        ...summarizeCategoryMonth({
          categoryId: row.id,
          name: row.name,
          spentCents: spent.get(row.id) ?? 0,
          budgetCents: budgetByCategory.get(row.id) ?? null,
        }),
        groupName: row.groupName,
      }));
    return { expense, incomeCents };
  });
}

export async function loadHistory(books: BooksContext): Promise<HistoryColumn[]> {
  const rows = await withActor(books.userId, (tx) =>
    tx
      .select({
        occurredOn: transaction.occurredOn,
        amountCents: transactionSplit.amountCents,
        kind: category.kind,
      })
      .from(transaction)
      .innerJoin(transactionSplit, eq(transactionSplit.transactionId, transaction.id))
      .innerJoin(category, eq(category.id, transactionSplit.categoryId))
      .where(eq(transaction.householdId, books.householdId)),
  );
  const expenses = rows.flatMap((row) => {
    const spentCents = effectOf(row.kind, row.amountCents).spentCents;
    return spentCents === 0 ? [] : [{ occurredOn: row.occurredOn, spentCents }];
  });
  const history = buildSpendingHistory({ expenses, asOf: books.asOf, monthCount: 12 });
  if (history.isErr()) throw history.error;
  return history.value;
}

export async function loadCategoryCatalog(books: BooksContext) {
  return withActor(books.userId, async (tx) => {
    const groups = await tx
      .select()
      .from(categoryGroup)
      .where(eq(categoryGroup.householdId, books.householdId));
    const categories = await tx
      .select({
        id: category.id,
        name: category.name,
        kind: category.kind,
        sortOrder: category.sortOrder,
        groupId: category.groupId,
      })
      .from(category)
      .where(eq(category.householdId, books.householdId));
    const byGroup = groups
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map((group) => ({
        id: group.id,
        name: group.name,
        categories: categories
          .filter((row) => row.groupId === group.id)
          .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
      }));
    const ungrouped = categories
      .filter((row) => row.groupId === null)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    return { groups: byGroup, ungrouped };
  });
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
