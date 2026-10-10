import {
  changeCategoryKind,
  defineCategory,
  defineCategoryGroup,
  moveCategory,
  removeCategoryGroup,
  renameCategoryGroup,
  shiftCategory,
  shiftGroup,
  type CatalogDirection,
  type CategoryCatalog,
} from "@dollas/domain";
import { and, count, desc, eq } from "drizzle-orm";
import { withActor } from "@/db/actor";
import { category, categoryBudget, categoryGroup } from "@/db/schema";
import { logInfo } from "@/lib/telemetry";
import { failure, refuse, succeed, type ServiceActor, type ServiceResult, type Via } from "@/lib/service-result";
import type { BooksContext } from "@/slices/access/member";
import { loadCategoryCatalog } from "@/slices/books/queries";
import { loadCatalog, saveCatalog } from "./catalog";

/**
 * Category and group services shared by the Categories page and MCP tools.
 * Catalog rules (names, order, kind changes, removing a group) are in
 * @dollas/domain; these load, decide, and save in one household transaction.
 */

const KNOWN = ["Choose a group in this household.", "That category is already in this group."];

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export type ListedCatalog = Awaited<ReturnType<typeof loadCategoryCatalog>>;

export async function listCategories(books: BooksContext): Promise<ServiceResult<ListedCatalog>> {
  try {
    return succeed(await loadCategoryCatalog(books));
  } catch (error) {
    return failure(error, "Could not load categories.", { action: "list-categories", householdId: books.householdId });
  }
}

export async function createCategoryGroup(
  actor: ServiceActor,
  rawName: string,
  via: Via = "web",
): Promise<ServiceResult<{ id: string; name: string }>> {
  const defined = defineCategoryGroup(rawName);
  if (defined.isErr()) return refuse(defined.error.message, defined.error);
  try {
    const id = await withActor(actor.userId, async (tx) => {
      const [last] = await tx
        .select({ sortOrder: categoryGroup.sortOrder })
        .from(categoryGroup)
        .where(eq(categoryGroup.householdId, actor.householdId))
        .orderBy(desc(categoryGroup.sortOrder))
        .limit(1);
      const [row] = await tx
        .insert(categoryGroup)
        .values({ householdId: actor.householdId, name: defined.value.name, sortOrder: (last?.sortOrder ?? -1) + 1 })
        .returning({ id: categoryGroup.id });
      if (!row) throw new Error("group insert returned no row");
      return row.id;
    });
    logInfo("Added a category group", { action: "create-category-group", via, householdId: actor.householdId });
    return succeed({ id, name: defined.value.name });
  } catch (error) {
    if (isUniqueViolation(error)) return refuse("That group already exists.", error);
    return failure(error, "Could not add that group.", { action: "create-category-group", via, householdId: actor.householdId });
  }
}

export async function createCategory(
  actor: ServiceActor,
  input: { name: string; kind: string; groupId: string },
  via: Via = "web",
): Promise<ServiceResult<{ id: string; name: string; kind: string; groupId: string }>> {
  const defined = defineCategory(input);
  if (defined.isErr()) return refuse(defined.error.message, defined.error);
  try {
    const id = await withActor(actor.userId, async (tx) => {
      const [group] = await tx
        .select({ id: categoryGroup.id })
        .from(categoryGroup)
        .where(and(eq(categoryGroup.id, defined.value.groupId), eq(categoryGroup.householdId, actor.householdId)));
      if (!group) throw new Error("Choose a group in this household.");
      const [existing] = await tx
        .select({ id: category.id })
        .from(category)
        .where(
          and(
            eq(category.householdId, actor.householdId),
            eq(category.groupId, defined.value.groupId),
            eq(category.name, defined.value.name),
          ),
        );
      if (existing) throw new Error("That category is already in this group.");
      const [last] = await tx
        .select({ sortOrder: category.sortOrder })
        .from(category)
        .where(eq(category.householdId, actor.householdId))
        .orderBy(desc(category.sortOrder))
        .limit(1);
      const [row] = await tx
        .insert(category)
        .values({
          householdId: actor.householdId,
          groupId: defined.value.groupId,
          name: defined.value.name,
          kind: defined.value.kind,
          sortOrder: (last?.sortOrder ?? -1) + 1,
        })
        .returning({ id: category.id });
      if (!row) throw new Error("category insert returned no row");
      return row.id;
    });
    logInfo("Added a category", { action: "create-category", via, householdId: actor.householdId });
    return succeed({ id, name: defined.value.name, kind: defined.value.kind, groupId: defined.value.groupId });
  } catch (error) {
    return failure(error, "Could not add that category.", { action: "create-category", via, householdId: actor.householdId }, KNOWN);
  }
}

async function commitCatalog(
  actor: ServiceActor,
  action: string,
  success: string,
  fallback: string,
  via: Via,
  change: (catalog: CategoryCatalog) => ReturnType<typeof renameCategoryGroup>,
): Promise<ServiceResult<{ done: true }>> {
  try {
    const refusal = await withActor(actor.userId, async (tx) => {
      const current = await loadCatalog(tx, actor.householdId);
      const next = change(current);
      if (next.isErr()) return next.error;
      await saveCatalog(tx, actor.householdId, current, next.value);
      return null;
    });
    if (refusal) return refuse(refusal.message, refusal);
  } catch (error) {
    if (action === "rename-category-group" && isUniqueViolation(error)) return refuse("That group already exists.", error);
    return failure(error, fallback, { action, via, householdId: actor.householdId });
  }
  logInfo(success, { action, via, householdId: actor.householdId });
  return succeed({ done: true });
}

export async function renameGroup(actor: ServiceActor, groupId: string, name: string, via: Via = "web") {
  return commitCatalog(actor, "rename-category-group", "Renamed a category group", "Could not rename that group.", via, (catalog) =>
    renameCategoryGroup(catalog, actor.householdId, groupId, name),
  );
}

/** Moves a category into another group, or out of every group when `groupId` is null. */
export async function moveCategoryToGroup(actor: ServiceActor, categoryId: string, groupId: string | null, via: Via = "web") {
  return commitCatalog(actor, "move-category", "Moved a category", "Could not move that category.", via, (catalog) =>
    moveCategory(catalog, actor.householdId, categoryId, groupId),
  );
}

export async function shiftGroupOrder(actor: ServiceActor, groupId: string, direction: CatalogDirection, via: Via = "web") {
  return commitCatalog(actor, "reorder-category-groups", "Reordered category groups", "Could not reorder groups.", via, (catalog) =>
    shiftGroup(catalog, actor.householdId, groupId, direction),
  );
}

export async function shiftCategoryOrder(actor: ServiceActor, categoryId: string, direction: CatalogDirection, via: Via = "web") {
  return commitCatalog(actor, "reorder-categories", "Reordered categories", "Could not reorder categories.", via, (catalog) =>
    shiftCategory(catalog, actor.householdId, categoryId, direction),
  );
}

/**
 * Removes a group. Its categories move to `destination` (a group id), out of
 * every group (null), or the domain refuses when the group is not empty and
 * no destination is given (undefined).
 */
export async function removeGroup(actor: ServiceActor, groupId: string, destination: string | null | undefined, via: Via = "web") {
  return commitCatalog(actor, "remove-category-group", "Removed a category group", "Could not remove that group.", via, (catalog) =>
    removeCategoryGroup(catalog, actor.householdId, groupId, destination),
  );
}

function readBudgetCount(value: unknown): number {
  const budgetCount = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isSafeInteger(budgetCount) || budgetCount < 0) throw new Error("Budget count is not valid.");
  return budgetCount;
}

/**
 * Switches a category between spending and income. When the category has
 * budgets, the change removes them and needs `confirmBudgetRemoval`.
 */
export async function changeKind(
  actor: ServiceActor,
  input: { categoryId: string; kind: string; confirmBudgetRemoval: boolean },
  via: Via = "web",
): Promise<ServiceResult<{ removedBudgets: boolean }>> {
  try {
    const outcome = await withActor(actor.userId, async (tx) => {
      const current = await loadCatalog(tx, actor.householdId);
      const [row] = await tx
        .select({ value: count() })
        .from(categoryBudget)
        .where(and(eq(categoryBudget.householdId, actor.householdId), eq(categoryBudget.categoryId, input.categoryId)));
      const next = changeCategoryKind(
        current,
        actor.householdId,
        input.categoryId,
        input.kind,
        readBudgetCount(row?.value),
        input.confirmBudgetRemoval,
      );
      if (next.isErr()) return { refused: true as const, error: next.error };
      await saveCatalog(tx, actor.householdId, current, next.value.catalog);
      if (next.value.removeBudgetsFor) {
        await tx
          .delete(categoryBudget)
          .where(and(eq(categoryBudget.householdId, actor.householdId), eq(categoryBudget.categoryId, next.value.removeBudgetsFor)));
      }
      return { refused: false as const, removedBudgets: Boolean(next.value.removeBudgetsFor) };
    });
    if (outcome.refused) return refuse(outcome.error.message, outcome.error);
    logInfo("Changed a category kind", { action: "change-category-kind", via, householdId: actor.householdId });
    return succeed({ removedBudgets: outcome.removedBudgets });
  } catch (error) {
    return failure(error, "Could not change that category's kind.", { action: "change-category-kind", via, householdId: actor.householdId });
  }
}
