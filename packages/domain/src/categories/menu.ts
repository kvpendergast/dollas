import { err, ok, type Result } from "neverthrow";
import { InvalidCategoryError } from "../errors";
import { categoryKindLabel, categoryKinds, isCategoryKind, type CategoryKind } from "./define";
import { compareCatalogOrder } from "./organize";

export type CategoryMenuEntry = {
  id: string;
  name: string;
  kind: string;
  sortOrder: number;
  groupId: string | null;
  groupName: string | null;
  groupSort: number | null;
};

export type CategoryMenuSection = {
  id: string;
  label: string;
  groupLabel: string;
  kind: CategoryKind;
  items: CategoryMenuEntry[];
};

/**
 * Activity's category menu keeps a household group and a kind as separate
 * headings. A group that contains income, expense, and transfer becomes three
 * sections. The kind of whichever category was added first does not decide
 * the section for the rest. Items inside a section stay in the order the household set.
 */
export function categoryMenuSections(
  categories: readonly CategoryMenuEntry[],
): Result<CategoryMenuSection[], InvalidCategoryError> {
  const sections = new Map<string, CategoryMenuSection>();
  for (const category of categories) {
    if (!isCategoryKind(category.kind)) {
      return err(new InvalidCategoryError("Choose income, expense, or transfer."));
    }
    const groupLabel = category.groupId ? (category.groupName ?? "Group") : "Ungrouped";
    const id = `${category.groupId ?? "ungrouped"}:${category.kind}`;
    const current = sections.get(id) ?? {
      id,
      label: `${groupLabel} · ${categoryKindLabel(category.kind)}`,
      groupLabel,
      kind: category.kind,
      items: [],
    };
    current.items.push(category);
    sections.set(id, current);
  }
  for (const section of sections.values()) {
    section.items.sort(compareEntries);
  }
  return ok([...sections.values()].sort(compareSections));
}

function compareEntries(a: CategoryMenuEntry, b: CategoryMenuEntry): number {
  return compareCatalogOrder(a, b);
}

function compareSections(a: CategoryMenuSection, b: CategoryMenuSection): number {
  const aGroup = a.items[0]?.groupId ? (a.items[0].groupSort ?? 0) : Number.MAX_SAFE_INTEGER;
  const bGroup = b.items[0]?.groupId ? (b.items[0].groupSort ?? 0) : Number.MAX_SAFE_INTEGER;
  if (aGroup !== bGroup) return aGroup - bGroup;
  const byName = a.groupLabel.localeCompare(b.groupLabel);
  if (byName !== 0) return byName;
  return categoryKinds.indexOf(a.kind) - categoryKinds.indexOf(b.kind);
}
