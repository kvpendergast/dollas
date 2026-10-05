import { and, eq } from "drizzle-orm";
import type { CategoryCatalog } from "@dollas/domain";
import type { AppTx } from "@/db/client";
import { category, categoryGroup } from "@/db/schema";

export async function loadCatalog(tx: AppTx, householdId: string): Promise<CategoryCatalog> {
  const groups = await tx
    .select({
      id: categoryGroup.id,
      householdId: categoryGroup.householdId,
      name: categoryGroup.name,
      sortOrder: categoryGroup.sortOrder,
    })
    .from(categoryGroup)
    .where(eq(categoryGroup.householdId, householdId));
  const categories = await tx
    .select({
      id: category.id,
      householdId: category.householdId,
      groupId: category.groupId,
      name: category.name,
      kind: category.kind,
      sortOrder: category.sortOrder,
    })
    .from(category)
    .where(eq(category.householdId, householdId));
  return { groups, categories };
}

/**
 * Writes the catalog diff. Categories move before a group is deleted because
 * the foreign key rejects deleting a group that still has categories.
 */
export async function saveCatalog(
  tx: AppTx,
  householdId: string,
  before: CategoryCatalog,
  after: CategoryCatalog,
): Promise<void> {
  if (before === after) return;
  const beforeGroups = new Map(before.groups.map((group) => [group.id, group]));
  const afterGroups = new Map(after.groups.map((group) => [group.id, group]));
  const beforeCategories = new Map(before.categories.map((row) => [row.id, row]));

  for (const row of after.categories) {
    const previous = beforeCategories.get(row.id);
    if (!previous || previous.householdId !== householdId || row.householdId !== householdId) continue;
    if (previous.groupId === row.groupId && previous.sortOrder === row.sortOrder) continue;
    const updated = await tx
      .update(category)
      .set({ groupId: row.groupId, sortOrder: row.sortOrder })
      .where(and(eq(category.id, row.id), eq(category.householdId, householdId)))
      .returning({ id: category.id });
    if (updated.length === 0) throw new Error("Category update did not apply.");
  }

  for (const [id, group] of beforeGroups) {
    if (afterGroups.has(id) || group.householdId !== householdId) continue;
    const removed = await tx
      .delete(categoryGroup)
      .where(and(eq(categoryGroup.id, id), eq(categoryGroup.householdId, householdId)))
      .returning({ id: categoryGroup.id });
    if (removed.length === 0) throw new Error("Category group delete did not apply.");
  }

  for (const group of after.groups) {
    const previous = beforeGroups.get(group.id);
    if (!previous || previous.householdId !== householdId || group.householdId !== householdId) continue;
    if (previous.name === group.name && previous.sortOrder === group.sortOrder) continue;
    const updated = await tx
      .update(categoryGroup)
      .set({ name: group.name, sortOrder: group.sortOrder })
      .where(and(eq(categoryGroup.id, group.id), eq(categoryGroup.householdId, householdId)))
      .returning({ id: categoryGroup.id });
    if (updated.length === 0) throw new Error("Category group update did not apply.");
  }
}
