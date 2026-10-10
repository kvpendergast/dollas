import {
  buildSpendingBreakdown,
  defineSavedFilterName,
  defineSpendingFilter,
  emptySpendingFilter,
  resolveFilterRange,
  type BreakdownSlice,
  type SpendingBreakdown,
  type SpendingFilter,
} from "@dollas/domain";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { withActor } from "@/db/actor";
import { category, categoryGroup, ledgerAccount, savedFilter, transaction, transactionSplit, user } from "@/db/schema";
import { logInfo } from "@/lib/telemetry";
import { UUID, failure, refuse, succeed, type ServiceActor, type ServiceResult, type Via } from "@/lib/service-result";
import { lineCondition, transactionConditions } from "./filter-sql";

/**
 * Spending dashboard and saved filters (PEN-212), shared by the History page,
 * Activity, and MCP tools. Everything runs as the member through RLS.
 */

export type NamedSlice = BreakdownSlice & { name: string };

export type SpendingDashboard = Omit<SpendingBreakdown, "byCategory" | "byGroup" | "byAccount" | "byMember"> & {
  filter: SpendingFilter;
  byCategory: Array<NamedSlice & { groupName: string | null }>;
  byGroup: NamedSlice[];
  byAccount: NamedSlice[];
  /** Attributed by memberRole: who categorized when the filter says so, otherwise who added. */
  memberRole: "added" | "categorized";
  byMember: NamedSlice[];
};

export const UNKNOWN_MEMBER_NAME = "Unknown";
const NOT_HERE = "That saved filter is not in this household.";

export async function getSpendingBreakdown(actor: ServiceActor, input: unknown, today: string): Promise<ServiceResult<SpendingDashboard>> {
  const defined = defineSpendingFilter(input);
  if (defined.isErr()) return refuse(defined.error.message, defined.error);
  const filter = defined.value;
  const memberRole = filter.memberRole === "categorized" ? "categorized" : "added";
  try {
    const loaded = await withActor(actor.userId, async (tx) => {
      const where = transactionConditions(actor.householdId, filter, today);
      where.push(sql`${transaction.deletedAt} is null`);
      const line = lineCondition(filter);
      const lines = await tx
        .select({
          transactionId: transaction.id,
          occurredOn: transaction.occurredOn,
          accountId: transaction.accountId,
          memberId: memberRole === "categorized" ? transaction.categorizedByUserId : transaction.createdByUserId,
          categoryId: transactionSplit.categoryId,
          splitCents: transactionSplit.amountCents,
          kind: category.kind,
          groupId: category.groupId,
        })
        .from(transaction)
        .innerJoin(transactionSplit, eq(transactionSplit.transactionId, transaction.id))
        .innerJoin(category, eq(category.id, transactionSplit.categoryId))
        .where(and(...where, line));
      const categories = await tx
        .select({ id: category.id, name: category.name, groupName: categoryGroup.name })
        .from(category)
        .leftJoin(categoryGroup, eq(categoryGroup.id, category.groupId))
        .where(eq(category.householdId, actor.householdId));
      const groups = await tx.select({ id: categoryGroup.id, name: categoryGroup.name }).from(categoryGroup).where(eq(categoryGroup.householdId, actor.householdId));
      const accounts = await tx.select({ id: ledgerAccount.id, name: ledgerAccount.name }).from(ledgerAccount).where(eq(ledgerAccount.householdId, actor.householdId));
      const memberIds = [...new Set(lines.flatMap((row) => (row.memberId ? [row.memberId] : [])))];
      const members = memberIds.length === 0 ? [] : await tx.select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, memberIds));
      return { lines, categories, groups, accounts, members };
    });
    const range = resolveFilterRange(filter, today);
    const breakdown = buildSpendingBreakdown({
      from: range.from,
      to: range.to,
      today,
      lines: loaded.lines.map((row) => ({
        transactionId: row.transactionId,
        occurredOn: row.occurredOn,
        accountId: row.accountId,
        memberId: row.memberId,
        categoryId: row.categoryId,
        groupId: row.groupId,
        kind: row.kind,
        amountCents: row.splitCents,
      })),
    });
    const categoryById = new Map(loaded.categories.map((row) => [row.id, row] as const));
    const nameOf = (rows: Array<{ id: string; name: string }>, fallback: string) => {
      const map = new Map(rows.map((row) => [row.id, row.name] as const));
      return (key: string | null) => (key == null ? fallback : (map.get(key) ?? fallback));
    };
    const groupName = nameOf(loaded.groups, "No group");
    const accountName = nameOf(loaded.accounts, "Account");
    const memberName = nameOf(loaded.members, UNKNOWN_MEMBER_NAME);
    return succeed({
      ...breakdown,
      filter,
      memberRole,
      byCategory: breakdown.byCategory.map((slice) => {
        const row = slice.key ? categoryById.get(slice.key) : undefined;
        return { ...slice, name: row?.name ?? "Category", groupName: row?.groupName ?? null };
      }),
      byGroup: breakdown.byGroup.map((slice) => ({ ...slice, name: groupName(slice.key) })),
      byAccount: breakdown.byAccount.map((slice) => ({ ...slice, name: accountName(slice.key) })),
      byMember: breakdown.byMember.map((slice) => ({ ...slice, name: memberName(slice.key) })),
    });
  } catch (error) {
    return failure(error, "Could not load spending.", { action: "load-spending-breakdown", householdId: actor.householdId });
  }
}

export type SavedFilterSummary = { id: string; name: string; filter: SpendingFilter; createdBy: string | null; createdAt: string };

export async function listSavedFilters(actor: ServiceActor): Promise<ServiceResult<SavedFilterSummary[]>> {
  try {
    const rows = await withActor(actor.userId, (tx) =>
      tx
        .select({ id: savedFilter.id, name: savedFilter.name, filter: savedFilter.filter, createdBy: user.name, createdAt: savedFilter.createdAt })
        .from(savedFilter)
        .leftJoin(user, eq(user.id, savedFilter.createdByUserId))
        .where(eq(savedFilter.householdId, actor.householdId))
        .orderBy(asc(sql`lower(${savedFilter.name})`)),
    );
    return succeed(
      rows.map((row) => {
        // Stored filters are re-validated; one that no longer parses opens as an empty filter.
        const parsed = defineSpendingFilter(row.filter);
        return {
          id: row.id,
          name: row.name,
          filter: parsed.isOk() ? parsed.value : emptySpendingFilter(),
          createdBy: row.createdBy,
          createdAt: row.createdAt.toISOString(),
        };
      }),
    );
  } catch (error) {
    return failure(error, "Could not load saved filters.", { action: "list-saved-filters", householdId: actor.householdId });
  }
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
}

function duplicateName(name: string) {
  return `A saved filter named “${name}” already exists.`;
}

export async function createSavedFilter(
  actor: ServiceActor,
  input: { name: string; filter: unknown },
  via: Via = "web",
): Promise<ServiceResult<SavedFilterSummary>> {
  const name = defineSavedFilterName(input.name);
  if (name.isErr()) return refuse(name.error.message, name.error);
  const filter = defineSpendingFilter(input.filter);
  if (filter.isErr()) return refuse(filter.error.message, filter.error);
  try {
    const [row] = await withActor(actor.userId, (tx) =>
      tx
        .insert(savedFilter)
        .values({ householdId: actor.householdId, name: name.value, filter: filter.value, createdByUserId: actor.userId })
        .returning({ id: savedFilter.id, createdAt: savedFilter.createdAt }),
    );
    logInfo("Saved filter added", { action: "create-saved-filter", via, householdId: actor.householdId });
    return succeed({ id: row.id, name: name.value, filter: filter.value, createdBy: null, createdAt: row.createdAt.toISOString() });
  } catch (error) {
    if (isUniqueViolation(error)) return refuse(duplicateName(name.value), error);
    return failure(error, "Could not save that filter.", { action: "create-saved-filter", via, householdId: actor.householdId });
  }
}

export async function renameSavedFilter(
  actor: ServiceActor,
  id: string,
  rawName: string,
  via: Via = "web",
): Promise<ServiceResult<{ id: string; name: string }>> {
  if (!UUID.test(id)) return refuse(NOT_HERE);
  const name = defineSavedFilterName(rawName);
  if (name.isErr()) return refuse(name.error.message, name.error);
  try {
    const updated = await withActor(actor.userId, (tx) =>
      tx
        .update(savedFilter)
        .set({ name: name.value, updatedAt: new Date() })
        .where(and(eq(savedFilter.id, id), eq(savedFilter.householdId, actor.householdId)))
        .returning({ id: savedFilter.id }),
    );
    if (updated.length === 0) return refuse(NOT_HERE);
    logInfo("Saved filter renamed", { action: "rename-saved-filter", via, householdId: actor.householdId });
    return succeed({ id, name: name.value });
  } catch (error) {
    if (isUniqueViolation(error)) return refuse(duplicateName(name.value), error);
    return failure(error, "Could not rename that filter.", { action: "rename-saved-filter", via, householdId: actor.householdId });
  }
}

export async function deleteSavedFilter(actor: ServiceActor, id: string, via: Via = "web"): Promise<ServiceResult<{ id: string; name: string }>> {
  if (!UUID.test(id)) return refuse(NOT_HERE);
  try {
    const removed = await withActor(actor.userId, (tx) =>
      tx
        .delete(savedFilter)
        .where(and(eq(savedFilter.id, id), eq(savedFilter.householdId, actor.householdId)))
        .returning({ id: savedFilter.id, name: savedFilter.name }),
    );
    if (removed.length === 0) return refuse(NOT_HERE);
    logInfo("Saved filter deleted", { action: "delete-saved-filter", via, householdId: actor.householdId });
    return succeed(removed[0]);
  } catch (error) {
    return failure(error, "Could not delete that filter.", { action: "delete-saved-filter", via, householdId: actor.householdId });
  }
}

/** A saved filter by id, for tools that take saved_filter_id. */
export async function getSavedFilter(actor: ServiceActor, id: string): Promise<ServiceResult<SavedFilterSummary>> {
  if (!UUID.test(id)) return refuse(NOT_HERE);
  const listed = await listSavedFilters(actor);
  if (!listed.ok) return listed;
  const found = listed.value.find((row) => row.id === id);
  return found ? succeed(found) : refuse(NOT_HERE);
}
