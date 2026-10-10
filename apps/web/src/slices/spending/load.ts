import { filterFromSearchParams, toIsoDate, type RangePreset, type SpendingFilter } from "@dollas/domain";
import { asc, eq } from "drizzle-orm";
import { withActor } from "@/db/actor";
import { category, categoryGroup, ledgerAccount } from "@/db/schema";
import type { BooksContext } from "@/slices/access/member";
import { listHouseholdPeople } from "@/slices/household/invites";
import { listSavedFilters, type SavedFilterSummary } from "./service";

export type FilterChoices = {
  accounts: Array<{ id: string; name: string; archived: boolean }>;
  groups: Array<{ id: string; name: string; categories: Array<{ id: string; name: string }> }>;
  ungrouped: Array<{ id: string; name: string }>;
  members: Array<{ id: string; name: string }>;
};

export type FilterContext = {
  filter: SpendingFilter;
  today: string;
  defaultRange: RangePreset;
  choices: FilterChoices;
  saved: SavedFilterSummary[];
};

/** What a filter bar needs: the filter from the URL, the choices to offer, and the household's saved filters. */
export async function loadFilterContext(
  books: BooksContext,
  params: Record<string, string | string[] | undefined>,
  defaultRange: RangePreset,
): Promise<FilterContext> {
  const filter = filterFromSearchParams(params, defaultRange);
  const [rows, people, saved] = await Promise.all([
    withActor(books.userId, async (tx) => ({
      accounts: await tx
        .select({ id: ledgerAccount.id, name: ledgerAccount.name, archivedAt: ledgerAccount.archivedAt })
        .from(ledgerAccount)
        .where(eq(ledgerAccount.householdId, books.householdId))
        .orderBy(asc(ledgerAccount.name)),
      groups: await tx
        .select({ id: categoryGroup.id, name: categoryGroup.name })
        .from(categoryGroup)
        .where(eq(categoryGroup.householdId, books.householdId))
        .orderBy(asc(categoryGroup.sortOrder), asc(categoryGroup.name)),
      categories: await tx
        .select({ id: category.id, name: category.name, groupId: category.groupId })
        .from(category)
        .where(eq(category.householdId, books.householdId))
        .orderBy(asc(category.sortOrder), asc(category.name)),
    })),
    listHouseholdPeople(books),
    listSavedFilters(books),
  ]);
  return {
    filter,
    today: toIsoDate(books.asOf),
    defaultRange,
    choices: {
      accounts: rows.accounts.map((row) => ({ id: row.id, name: row.name, archived: row.archivedAt !== null })),
      groups: rows.groups.map((group) => ({
        id: group.id,
        name: group.name,
        categories: rows.categories.filter((row) => row.groupId === group.id).map(({ id, name }) => ({ id, name })),
      })),
      ungrouped: rows.categories.filter((row) => row.groupId === null).map(({ id, name }) => ({ id, name })),
      members: people.ok ? people.value.members.map((member) => ({ id: member.userId, name: member.name })) : [],
    },
    saved: saved.ok ? saved.value : [],
  };
}
