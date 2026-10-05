import { err, ok, type Result } from "neverthrow";
import { InvalidCategoryError } from "../errors";
import { defineCategoryGroup } from "./define";

export type CatalogDirection = "up" | "down";

export type OrganizedGroup = {
  id: string;
  householdId: string;
  name: string;
  sortOrder: number;
};

export type OrganizedCategory = {
  id: string;
  householdId: string;
  groupId: string | null;
  name: string;
  kind: string;
  sortOrder: number;
};

export type CategoryCatalog = {
  groups: readonly OrganizedGroup[];
  categories: readonly OrganizedCategory[];
};

/**
 * The order a household set, used wherever groups or categories are listed.
 * Sort order wins, then the name, then the id so two callers agree.
 */
export function compareCatalogOrder(
  a: { id: string; sortOrder: number; name: string },
  b: { id: string; sortOrder: number; name: string },
): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}

function groupsIn(catalog: CategoryCatalog, householdId: string): OrganizedGroup[] {
  return catalog.groups.filter((group) => group.householdId === householdId).sort(compareCatalogOrder);
}

function categoriesIn(catalog: CategoryCatalog, householdId: string, groupId: string | null): OrganizedCategory[] {
  return catalog.categories
    .filter((row) => row.householdId === householdId && row.groupId === groupId)
    .sort(compareCatalogOrder);
}

function stepIds(ids: readonly string[], id: string, direction: CatalogDirection): string[] | null {
  const index = ids.indexOf(id);
  const nextIndex = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || nextIndex < 0 || nextIndex >= ids.length) return null;
  const swapped = [...ids];
  const current = swapped[index];
  const neighbor = swapped[nextIndex];
  if (current === undefined || neighbor === undefined) return null;
  swapped[index] = neighbor;
  swapped[nextIndex] = current;
  return swapped;
}

/** Rename a group in this household. Another household's group is left alone. */
export function renameCategoryGroup(
  catalog: CategoryCatalog,
  householdId: string,
  groupId: string,
  name: string,
): Result<CategoryCatalog, InvalidCategoryError> {
  const defined = defineCategoryGroup(name);
  if (defined.isErr()) return err(defined.error);
  const group = catalog.groups.find((row) => row.id === groupId);
  if (!group || group.householdId !== householdId) {
    return err(new InvalidCategoryError("Choose a group in this household."));
  }
  if (group.name === defined.value.name) return ok(catalog);
  const clash = catalog.groups.some(
    (row) => row.householdId === householdId && row.id !== groupId && row.name === defined.value.name,
  );
  if (clash) return err(new InvalidCategoryError("That group already exists."));
  return ok({
    groups: catalog.groups.map((row) => (row.id === groupId ? { ...row, name: defined.value.name } : row)),
    categories: catalog.categories,
  });
}

function placeCategories(
  catalog: CategoryCatalog,
  householdId: string,
  moving: readonly OrganizedCategory[],
  destinationGroupId: string | null,
): Result<ReadonlyMap<string, OrganizedCategory>, InvalidCategoryError> {
  const movingIds = new Set(moving.map((row) => row.id));
  const destination = categoriesIn(catalog, householdId, destinationGroupId).filter((row) => !movingIds.has(row.id));
  const taken = new Set(destination.map((row) => row.name));
  let sortOrder = destination.reduce((max, row) => Math.max(max, row.sortOrder), -1) + 1;
  const updates = new Map<string, OrganizedCategory>();
  for (const row of [...moving].sort(compareCatalogOrder)) {
    if (taken.has(row.name)) {
      const message =
        destinationGroupId === null
          ? `${row.name} is already ungrouped.`
          : `${row.name} is already in this group.`;
      return err(new InvalidCategoryError(message));
    }
    taken.add(row.name);
    updates.set(row.id, { ...row, groupId: destinationGroupId, sortOrder });
    sortOrder += 1;
  }
  return ok(updates);
}

function applyCategoryUpdates(
  catalog: CategoryCatalog,
  updates: ReadonlyMap<string, OrganizedCategory>,
): CategoryCatalog {
  return {
    groups: catalog.groups,
    categories: catalog.categories.map((row) => updates.get(row.id) ?? row),
  };
}

/** Move one category to another group, or to no group. It lands at the end of that list. */
export function moveCategory(
  catalog: CategoryCatalog,
  householdId: string,
  categoryId: string,
  destinationGroupId: string | null,
): Result<CategoryCatalog, InvalidCategoryError> {
  const category = catalog.categories.find((row) => row.id === categoryId);
  if (!category || category.householdId !== householdId) {
    return err(new InvalidCategoryError("Choose a category in this household."));
  }
  if (destinationGroupId !== null) {
    const destination = catalog.groups.find((row) => row.id === destinationGroupId);
    if (!destination || destination.householdId !== householdId) {
      return err(new InvalidCategoryError("Choose a group in this household."));
    }
  }
  if (category.groupId === destinationGroupId) return ok(catalog);
  const placed = placeCategories(catalog, householdId, [category], destinationGroupId);
  if (placed.isErr()) return err(placed.error);
  return ok(applyCategoryUpdates(catalog, placed.value));
}

/** Set the full group order. `orderedIds` is every group in this household, once. */
export function reorderGroups(
  catalog: CategoryCatalog,
  householdId: string,
  orderedIds: readonly string[],
): Result<CategoryCatalog, InvalidCategoryError> {
  const own = groupsIn(catalog, householdId);
  const seen = new Set<string>();
  for (const id of orderedIds) {
    const group = catalog.groups.find((row) => row.id === id);
    if (!group || group.householdId !== householdId) {
      return err(new InvalidCategoryError("Choose a group in this household."));
    }
    if (seen.has(id)) return err(new InvalidCategoryError("Include every group once."));
    seen.add(id);
  }
  if (seen.size !== own.length) return err(new InvalidCategoryError("Include every group once."));
  const sortById = new Map(orderedIds.map((id, index) => [id, index]));
  let changed = false;
  const groups = catalog.groups.map((group) => {
    const sortOrder = sortById.get(group.id);
    if (sortOrder === undefined || group.sortOrder === sortOrder) return group;
    changed = true;
    return { ...group, sortOrder };
  });
  if (!changed) return ok(catalog);
  return ok({ groups, categories: catalog.categories });
}

/** Move a group up or down within this household. The ends stay put. */
export function shiftGroup(
  catalog: CategoryCatalog,
  householdId: string,
  groupId: string,
  direction: CatalogDirection,
): Result<CategoryCatalog, InvalidCategoryError> {
  const own = groupsIn(catalog, householdId);
  if (!own.some((group) => group.id === groupId)) {
    return err(new InvalidCategoryError("Choose a group in this household."));
  }
  const next = stepIds(
    own.map((group) => group.id),
    groupId,
    direction,
  );
  if (!next) return ok(catalog);
  return reorderGroups(catalog, householdId, next);
}

/**
 * Set the category order inside one group. `groupId` null is the ungrouped list.
 * `orderedIds` is every category in that list for this household, once.
 */
export function reorderCategories(
  catalog: CategoryCatalog,
  householdId: string,
  groupId: string | null,
  orderedIds: readonly string[],
): Result<CategoryCatalog, InvalidCategoryError> {
  if (groupId !== null) {
    const group = catalog.groups.find((row) => row.id === groupId);
    if (!group || group.householdId !== householdId) {
      return err(new InvalidCategoryError("Choose a group in this household."));
    }
  }
  const own = categoriesIn(catalog, householdId, groupId);
  const seen = new Set<string>();
  for (const id of orderedIds) {
    const row = catalog.categories.find((item) => item.id === id);
    if (!row || row.householdId !== householdId) {
      return err(new InvalidCategoryError("Choose a category in this household."));
    }
    if (row.groupId !== groupId || seen.has(id)) {
      return err(new InvalidCategoryError("Include every category in this group once."));
    }
    seen.add(id);
  }
  if (seen.size !== own.length) return err(new InvalidCategoryError("Include every category in this group once."));
  const sortById = new Map(orderedIds.map((id, index) => [id, index]));
  let changed = false;
  const categories = catalog.categories.map((row) => {
    const sortOrder = sortById.get(row.id);
    if (sortOrder === undefined || row.sortOrder === sortOrder) return row;
    changed = true;
    return { ...row, sortOrder };
  });
  if (!changed) return ok(catalog);
  return ok({ groups: catalog.groups, categories });
}

/** Move a category up or down inside its group, or inside the ungrouped list. */
export function shiftCategory(
  catalog: CategoryCatalog,
  householdId: string,
  categoryId: string,
  direction: CatalogDirection,
): Result<CategoryCatalog, InvalidCategoryError> {
  const category = catalog.categories.find((row) => row.id === categoryId);
  if (!category || category.householdId !== householdId) {
    return err(new InvalidCategoryError("Choose a category in this household."));
  }
  const own = categoriesIn(catalog, householdId, category.groupId);
  const next = stepIds(
    own.map((row) => row.id),
    categoryId,
    direction,
  );
  if (!next) return ok(catalog);
  return reorderCategories(catalog, householdId, category.groupId, next);
}

/**
 * Remove a group. An empty group goes away. A group that still has categories
 * moves them to another group, or to no group, and then goes away.
 * Omit `destinationGroupId` only when the group is empty. Null means ungrouped.
 */
export function removeCategoryGroup(
  catalog: CategoryCatalog,
  householdId: string,
  groupId: string,
  destinationGroupId?: string | null,
): Result<CategoryCatalog, InvalidCategoryError> {
  const group = catalog.groups.find((row) => row.id === groupId);
  if (!group || group.householdId !== householdId) {
    return err(new InvalidCategoryError("Choose a group in this household."));
  }
  const members = categoriesIn(catalog, householdId, groupId);
  if (members.length === 0) {
    return ok({
      groups: catalog.groups.filter((row) => row.id !== groupId),
      categories: catalog.categories,
    });
  }
  if (destinationGroupId === undefined) {
    return err(new InvalidCategoryError("Choose where those categories should go."));
  }
  if (destinationGroupId === groupId) return err(new InvalidCategoryError("Choose a different group."));
  if (destinationGroupId !== null) {
    const destination = catalog.groups.find((row) => row.id === destinationGroupId);
    if (!destination || destination.householdId !== householdId) {
      return err(new InvalidCategoryError("Choose a group in this household."));
    }
  }
  const placed = placeCategories(catalog, householdId, members, destinationGroupId);
  if (placed.isErr()) return err(placed.error);
  const next = applyCategoryUpdates(catalog, placed.value);
  return ok({
    groups: next.groups.filter((row) => row.id !== groupId),
    categories: next.categories,
  });
}
