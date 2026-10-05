"use server";

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
import { revalidatePath } from "next/cache";
import { withActor } from "@/db/actor";
import { category, categoryBudget, categoryGroup } from "@/db/schema";
import { logError, logInfo } from "@/lib/telemetry";
import { requireBooks, type BooksContext } from "@/slices/access/guard";
import { loadCatalog, saveCatalog } from "./catalog";

const KNOWN = new Set(["Choose a group in this household.", "That category is already in this group."]);

function revalidateCategoryViews() {
  revalidatePath("/categories");
  revalidatePath("/activity");
  revalidatePath("/plan");
  revalidatePath("/history");
  revalidatePath("/projection");
  revalidatePath("/");
}

function readBudgetCount(value: unknown): number {
  const budgetCount = typeof value === "number" ? value : Number(value ?? 0);
  if (!Number.isSafeInteger(budgetCount) || budgetCount < 0) {
    throw new Error("Budget count is not valid.");
  }
  return budgetCount;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export async function createCategoryGroupAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const defined = defineCategoryGroup(String(formData.get("name") ?? ""));
  if (defined.isErr()) return { error: defined.error.message };
  try {
    await withActor(books.userId, async (tx) => {
      const [last] = await tx
        .select({ sortOrder: categoryGroup.sortOrder })
        .from(categoryGroup)
        .where(eq(categoryGroup.householdId, books.householdId))
        .orderBy(desc(categoryGroup.sortOrder))
        .limit(1);
      await tx.insert(categoryGroup).values({
        householdId: books.householdId,
        name: defined.value.name,
        sortOrder: (last?.sortOrder ?? -1) + 1,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { error: "That group already exists." };
    logError(error, { action: "create-category-group", householdId: books.householdId });
    return { error: "Could not add that group." };
  }
  revalidateCategoryViews();
  return { error: "" };
}

export async function createCategoryAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const defined = defineCategory({
    name: String(formData.get("name") ?? ""),
    kind: String(formData.get("kind") ?? ""),
    groupId: String(formData.get("groupId") ?? ""),
  });
  if (defined.isErr()) return { error: defined.error.message };
  try {
    await withActor(books.userId, async (tx) => {
      const [group] = await tx
        .select({ id: categoryGroup.id })
        .from(categoryGroup)
        .where(and(eq(categoryGroup.id, defined.value.groupId), eq(categoryGroup.householdId, books.householdId)));
      if (!group) throw new Error("Choose a group in this household.");
      const [existing] = await tx
        .select({ id: category.id })
        .from(category)
        .where(
          and(
            eq(category.householdId, books.householdId),
            eq(category.groupId, defined.value.groupId),
            eq(category.name, defined.value.name),
          ),
        );
      if (existing) throw new Error("That category is already in this group.");
      const [last] = await tx
        .select({ sortOrder: category.sortOrder })
        .from(category)
        .where(eq(category.householdId, books.householdId))
        .orderBy(desc(category.sortOrder))
        .limit(1);
      await tx.insert(category).values({
        householdId: books.householdId,
        groupId: defined.value.groupId,
        name: defined.value.name,
        kind: defined.value.kind,
        sortOrder: (last?.sortOrder ?? -1) + 1,
      });
    });
  } catch (error) {
    if (error instanceof Error && KNOWN.has(error.message)) return { error: error.message };
    logError(error, { action: "create-category", householdId: books.householdId });
    return { error: "Could not add that category." };
  }
  revalidateCategoryViews();
  return { error: "" };
}

const UNGROUPED = "ungrouped";

function readDirection(formData: FormData): CatalogDirection | null {
  const value = formData.get("direction");
  return value === "up" || value === "down" ? value : null;
}

function removalDestination(formData: FormData): string | null | undefined {
  if (!formData.has("destination")) return undefined;
  const raw = String(formData.get("destination") ?? "").trim();
  if (raw.length === 0) return undefined;
  if (raw === UNGROUPED) return null;
  return raw;
}

function moveDestination(formData: FormData): { error: string } | { destination: string | null } {
  const raw = String(formData.get("destination") ?? "").trim();
  if (raw.length === 0) return { error: "Choose where that category should go." };
  if (raw === UNGROUPED) return { destination: null };
  return { destination: raw };
}

async function commitCatalog(
  books: BooksContext,
  action: string,
  success: string,
  fallback: string,
  change: (catalog: CategoryCatalog) => ReturnType<typeof renameCategoryGroup>,
): Promise<{ error: string }> {
  try {
    const failure = await withActor(books.userId, async (tx) => {
      const current = await loadCatalog(tx, books.householdId);
      const next = change(current);
      if (next.isErr()) return next.error.message;
      await saveCatalog(tx, books.householdId, current, next.value);
      return "";
    });
    if (failure) return { error: failure };
  } catch (error) {
    if (action === "rename-category-group" && isUniqueViolation(error)) return { error: "That group already exists." };
    logError(error, { action, householdId: books.householdId });
    return { error: fallback };
  }
  logInfo(success, { action, householdId: books.householdId });
  revalidateCategoryViews();
  return { error: "" };
}

export async function renameCategoryGroupAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const groupId = String(formData.get("groupId") ?? "");
  const name = String(formData.get("name") ?? "");
  return commitCatalog(
    books,
    "rename-category-group",
    "Renamed a category group",
    "Could not rename that group.",
    (catalog) => renameCategoryGroup(catalog, books.householdId, groupId, name),
  );
}

export async function moveCategoryAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const destination = moveDestination(formData);
  if ("error" in destination) return destination;
  const categoryId = String(formData.get("categoryId") ?? "");
  return commitCatalog(
    books,
    "move-category",
    "Moved a category",
    "Could not move that category.",
    (catalog) => moveCategory(catalog, books.householdId, categoryId, destination.destination),
  );
}

export async function shiftCategoryGroupAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const direction = readDirection(formData);
  if (!direction) return { error: "Choose up or down." };
  const groupId = String(formData.get("groupId") ?? "");
  return commitCatalog(
    books,
    "reorder-category-groups",
    "Reordered category groups",
    "Could not reorder groups.",
    (catalog) => shiftGroup(catalog, books.householdId, groupId, direction),
  );
}

export async function shiftCategoryAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const direction = readDirection(formData);
  if (!direction) return { error: "Choose up or down." };
  const categoryId = String(formData.get("categoryId") ?? "");
  return commitCatalog(
    books,
    "reorder-categories",
    "Reordered categories",
    "Could not reorder categories.",
    (catalog) => shiftCategory(catalog, books.householdId, categoryId, direction),
  );
}

export async function changeCategoryKindAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const categoryId = String(formData.get("categoryId") ?? "");
  const kind = String(formData.get("kind") ?? "");
  const confirmBudgetRemoval = formData.get("confirmBudgetRemoval") === "yes";
  try {
    const failure = await withActor(books.userId, async (tx) => {
      const current = await loadCatalog(tx, books.householdId);
      const [row] = await tx
        .select({ value: count() })
        .from(categoryBudget)
        .where(and(eq(categoryBudget.householdId, books.householdId), eq(categoryBudget.categoryId, categoryId)));
      const next = changeCategoryKind(
        current,
        books.householdId,
        categoryId,
        kind,
        readBudgetCount(row?.value),
        confirmBudgetRemoval,
      );
      if (next.isErr()) return next.error.message;
      await saveCatalog(tx, books.householdId, current, next.value.catalog);
      if (next.value.removeBudgetsFor) {
        await tx
          .delete(categoryBudget)
          .where(
            and(
              eq(categoryBudget.householdId, books.householdId),
              eq(categoryBudget.categoryId, next.value.removeBudgetsFor),
            ),
          );
      }
      return "";
    });
    if (failure) return { error: failure };
  } catch (error) {
    logError(error, { action: "change-category-kind", householdId: books.householdId });
    return { error: "Could not change that category's kind." };
  }
  logInfo("Changed a category kind", { action: "change-category-kind", householdId: books.householdId });
  revalidateCategoryViews();
  return { error: "" };
}

export async function removeCategoryGroupAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const groupId = String(formData.get("groupId") ?? "");
  const destination = removalDestination(formData);
  return commitCatalog(
    books,
    "remove-category-group",
    "Removed a category group",
    "Could not remove that group.",
    (catalog) => removeCategoryGroup(catalog, books.householdId, groupId, destination),
  );
}
