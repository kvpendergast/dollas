import {
  accountBalanceCents,
  accountsForActiveLists,
  buildSpendingHistory,
  categoryBooksEffect,
  compareCatalogOrder,
  homeAccountTotalCents,
  isAccountType,
  summarizeCategoryMonth,
  toIsoDate,
  type AccountType,
  type CivilDate,
  type HistoryColumn,
} from "@dollas/domain";
import { and, asc, count, eq, gte, isNull, lte } from "drizzle-orm";
import { withActor } from "@/db/actor";
import {
  category,
  categoryBudget,
  categoryGroup,
  ledgerAccount,
  transaction,
  transactionSplit,
  recurringItem,
} from "@/db/schema";
import type { BooksContext } from "@/slices/access/guard";
import { listPayeeRules } from "@/slices/activity/payee-rule-service";
import { listHouseholdTransactions } from "@/slices/activity/transactions";
import { loadSpendEstimate } from "./estimate";

function monthStart(asOf: CivilDate): string {
  return toIsoDate({ year: asOf.year, month: asOf.month, day: 1 });
}

/** Posted rows only. A deleted transaction keeps its fingerprint but leaves the books. */
function postedInHousehold(householdId: string) {
  return and(eq(transaction.householdId, householdId), isNull(transaction.deletedAt));
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
  return compareCatalogOrder(a, b);
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
          postedInHousehold(books.householdId),
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
      .where(postedInHousehold(books.householdId));
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
  const estimate = await loadSpendEstimate(books);
  return {
    incomeCents,
    spentCents,
    leftCents: incomeCents - spentCents,
    budgetedCents,
    categories: categories.slice(0, 5),
    hasAccounts: accountsForActiveLists(accounts, books.householdId).length > 0,
    accountBalanceCents: accountTotal.value,
    /** Home's estimate card: the same numbers as the Spend estimate page and get_spend_estimate. */
    estimate: {
      estimateCents: estimate.thisMonth.estimateCents,
      spentSoFarCents: estimate.thisMonth.spentSoFarCents,
      recurringExpectedCents: estimate.thisMonth.recurringExpectedCents,
      paceCents: estimate.thisMonth.paceCents,
      dailyPaceCents: estimate.pace.dailyCents,
      paceBasis: estimate.pace.basis,
      nextMonthEstimateCents: estimate.nextMonth.estimateCents,
    },
  };
}

export const ACTIVITY_PAGE_SIZE = 60;

export async function loadActivity(books: BooksContext) {
  const listed = await listHouseholdTransactions(books, { limit: ACTIVITY_PAGE_SIZE, offset: 0 });
  if (!listed.ok) throw new Error(listed.memberMessage);
  const transactions = listed.value.items;
  const rules = await listPayeeRules(books);
  if (!rules.ok) throw new Error(rules.memberMessage);
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
      payeeRules: rules.value,
      recurringChoices: await tx
        .select({ id: recurringItem.id, name: recurringItem.name })
        .from(recurringItem)
        .where(eq(recurringItem.householdId, books.householdId))
        .orderBy(asc(recurringItem.name)),
      transactions,
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
      .where(postedInHousehold(books.householdId));
    return rollupAccounts(accounts, movements);
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
      .where(postedInHousehold(books.householdId)),
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
    const budgetRows = await tx
      .select({
        categoryId: categoryBudget.categoryId,
        budgetCount: count(),
      })
      .from(categoryBudget)
      .where(eq(categoryBudget.householdId, books.householdId))
      .groupBy(categoryBudget.categoryId);
    const budgetCounts = new Map(budgetRows.map((row) => [row.categoryId, Number(row.budgetCount)]));
    const listed = categories.map((row) => ({
      ...row,
      budgetCount: budgetCounts.get(row.id) ?? 0,
    }));
    const byGroup = [...groups].sort(compareCatalogOrder).map((group) => ({
      id: group.id,
      name: group.name,
      categories: listed.filter((row) => row.groupId === group.id).sort(compareCatalogOrder),
    }));
    const ungrouped = listed.filter((row) => row.groupId === null).sort(compareCatalogOrder);
    return { groups: byGroup, ungrouped };
  });
}

