"use server";

import { defineCategory, defineCategoryGroup } from "@dollas/domain";
import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withActor } from "@/db/actor";
import { category, categoryGroup } from "@/db/schema";
import { logError } from "@/lib/telemetry";
import { requireBooks } from "@/slices/access/guard";

const KNOWN = new Set(["Choose a group in this household.", "That category is already in this group."]);

function revalidateCategoryViews() {
  revalidatePath("/categories");
  revalidatePath("/activity");
  revalidatePath("/plan");
  revalidatePath("/");
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
