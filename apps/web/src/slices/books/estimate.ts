import { buildSpendEstimate, estimateWindowStart, toIsoDate, type SpendEstimate } from "@dollas/domain";
import { and, eq, gte, isNull, lte, min, or, sql } from "drizzle-orm";
import { withActor } from "@/db/actor";
import { category, categoryBudget, categoryGroup, recurringItem, recurringLink, transaction, transactionSplit } from "@/db/schema";
import type { BooksContext } from "@/slices/access/member";
import { loadStatusLinks, scheduleOf } from "@/slices/recurring/store";

/**
 * Loads what the spend estimate needs (PEN-205) and runs the domain model.
 * One loader for the Spend estimate page, Home's estimate card, and the
 * get_spend_estimate tool, so their numbers always match. `today` is the
 * household's civil date.
 */
export async function loadSpendEstimate(books: BooksContext): Promise<SpendEstimate> {
  const today = toIsoDate(books.asOf);
  const windowStart = estimateWindowStart(today);
  const nextMonth = books.asOf.month === 12 ? { year: books.asOf.year + 1, month: 1 } : { year: books.asOf.year, month: books.asOf.month + 1 };
  const nextEnd = toIsoDate({ ...nextMonth, day: new Date(Date.UTC(nextMonth.year, nextMonth.month, 0)).getUTCDate() });

  const loaded = await withActor(books.userId, async (tx) => {
    const splits = await tx
      .select({
        occurredOn: transaction.occurredOn,
        categoryId: transactionSplit.categoryId,
        kind: category.kind,
        amountCents: transactionSplit.amountCents,
        recurringLinkId: recurringLink.id,
      })
      .from(transaction)
      .innerJoin(transactionSplit, eq(transactionSplit.transactionId, transaction.id))
      .innerJoin(category, eq(category.id, transactionSplit.categoryId))
      .leftJoin(recurringLink, eq(recurringLink.transactionId, transaction.id))
      .where(
        and(
          eq(transaction.householdId, books.householdId),
          isNull(transaction.deletedAt),
          gte(transaction.occurredOn, windowStart),
          lte(transaction.occurredOn, today),
        ),
      );
    const [first] = await tx
      .select({ on: min(transaction.occurredOn) })
      .from(transaction)
      .where(and(eq(transaction.householdId, books.householdId), isNull(transaction.deletedAt)));
    const categories = await tx
      .select({ id: category.id, name: category.name, groupName: categoryGroup.name, kind: category.kind })
      .from(category)
      .leftJoin(categoryGroup, eq(categoryGroup.id, category.groupId))
      .where(eq(category.householdId, books.householdId));
    const budgets = await tx
      .select({ year: categoryBudget.year, month: categoryBudget.month, total: sql<string>`sum(${categoryBudget.amountCents})` })
      .from(categoryBudget)
      .where(
        and(
          eq(categoryBudget.householdId, books.householdId),
          or(
            and(eq(categoryBudget.year, books.asOf.year), eq(categoryBudget.month, books.asOf.month)),
            and(eq(categoryBudget.year, nextMonth.year), eq(categoryBudget.month, nextMonth.month)),
          ),
        ),
      )
      .groupBy(categoryBudget.year, categoryBudget.month);
    const items = await tx.select().from(recurringItem).where(eq(recurringItem.householdId, books.householdId));
    const links = await loadStatusLinks(tx, books.householdId, items.map((item) => item.id), `${today.slice(0, 7)}-01`, nextEnd);
    return { splits, first: first?.on ?? null, categories, budgets, items, links };
  });

  const budgetFor = (year: number, month: number) => {
    const row = loaded.budgets.find((budget) => budget.year === year && budget.month === month);
    return row ? Number(row.total) : null;
  };
  const estimate = buildSpendEstimate({
    today,
    splits: loaded.splits.map((row) => ({
      occurredOn: row.occurredOn,
      categoryId: row.categoryId,
      kind: row.kind,
      amountCents: row.amountCents,
      recurring: row.recurringLinkId != null,
    })),
    categories: loaded.categories.map((row) => ({ id: row.id, name: row.groupName ? `${row.groupName} · ${row.name}` : row.name, kind: row.kind })),
    firstTransactionOn: loaded.first,
    recurringItems: loaded.items.map((item) => ({ ...scheduleOf(item), categoryId: item.categoryId })),
    recurringLinks: loaded.links,
    budgetCents: { thisMonth: budgetFor(books.asOf.year, books.asOf.month), nextMonth: budgetFor(nextMonth.year, nextMonth.month) },
  });
  if (estimate.isErr()) throw estimate.error;
  return estimate.value;
}

