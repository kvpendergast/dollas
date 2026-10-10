import { toIsoDate, type CategoryMenuEntry } from "@dollas/domain";
import { and, asc, eq, isNull } from "drizzle-orm";
import { withActor } from "@/db/actor";
import { category, categoryGroup, ledgerAccount } from "@/db/schema";
import type { BooksContext } from "@/slices/access/member";
import { getRecurringItem, listRecurringItems, loadExpectedRecurring, suggestRecurring } from "./service";

/** Category and account choices for the Recurring form. */
async function loadChoices(books: BooksContext): Promise<{ categories: CategoryMenuEntry[]; accounts: Array<{ id: string; name: string }> }> {
  return withActor(books.userId, async (tx) => {
    const categories = await tx
      .select({
        id: category.id,
        name: category.name,
        kind: category.kind,
        groupId: category.groupId,
        groupName: categoryGroup.name,
        groupSort: categoryGroup.sortOrder,
        sortOrder: category.sortOrder,
      })
      .from(category)
      .leftJoin(categoryGroup, eq(categoryGroup.id, category.groupId))
      .where(eq(category.householdId, books.householdId));
    categories.sort((a, b) => (a.groupSort ?? 1e9) - (b.groupSort ?? 1e9) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    const accounts = await tx
      .select({ id: ledgerAccount.id, name: ledgerAccount.name })
      .from(ledgerAccount)
      .where(and(eq(ledgerAccount.householdId, books.householdId), isNull(ledgerAccount.archivedAt)))
      .orderBy(asc(ledgerAccount.name));
    return { categories, accounts };
  });
}

export async function loadRecurringPage(books: BooksContext) {
  const today = toIsoDate(books.asOf);
  const monthStart = `${today.slice(0, 8)}01`;
  const lastDay = new Date(Date.UTC(books.asOf.year, books.asOf.month, 0)).getUTCDate();
  const monthEnd = toIsoDate({ ...books.asOf, day: lastDay });
  const [items, suggestions, month, choices] = await Promise.all([
    listRecurringItems(books, today),
    suggestRecurring(books, today),
    loadExpectedRecurring(books, { from: monthStart, to: monthEnd }, today),
    loadChoices(books),
  ]);
  if (!items.ok) throw new Error(items.memberMessage);
  if (!month.ok) throw new Error(month.memberMessage);
  return { today, items: items.value, suggestions: suggestions.ok ? suggestions.value : [], month: month.value, ...choices };
}

export async function loadRecurringDetail(books: BooksContext, itemId: string) {
  const today = toIsoDate(books.asOf);
  const [item, choices] = await Promise.all([getRecurringItem(books, itemId, today), loadChoices(books)]);
  if (!item.ok) return { today, item: null, error: item.memberMessage, ...choices };
  return { today, item: item.value, error: "", ...choices };
}
