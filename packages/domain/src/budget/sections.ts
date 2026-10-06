import { err, ok, type Result } from "neverthrow";
import { BudgetError } from "../errors";
import { isCategoryKind } from "../categories/define";
import { compareCatalogOrder } from "../categories/organize";
import { summarizeCategoryMonth, type CategoryMonth } from "../plan/budget-status";

export const UNGROUPED_SECTION_ID = "ungrouped";
export const UNGROUPED_SECTION_NAME = "Ungrouped";

export type PlanCategorySource = {
  categoryId: string;
  name: string;
  kind: string;
  sortOrder: number;
  groupId: string | null;
  groupName: string | null;
  groupSort: number | null;
  spentCents: number;
  budgetCents: number | null;
};

export type PlanCategoryLine = CategoryMonth & {
  sortOrder: number;
  groupId: string | null;
  groupName: string | null;
  groupSort: number | null;
};

export type PlanSection = {
  id: string;
  name: string;
  categories: PlanCategoryLine[];
};

/**
 * Plan lists expense categories only, in the household's group order.
 * Income and transfer stay off the plan. Categories with no group share one section.
 */
export function planSections(sources: readonly PlanCategorySource[]): Result<PlanSection[], BudgetError> {
  const buckets = new Map<string, PlanSection & { groupSort: number }>();
  for (const source of sources) {
    if (!isCategoryKind(source.kind)) return err(new BudgetError("Choose income, expense, or transfer."));
    if (source.kind !== "expense") continue;
    const summarized = summarizeCategoryMonth({
      categoryId: source.categoryId,
      name: source.name,
      spentCents: source.spentCents,
      budgetCents: source.budgetCents,
    });
    const line: PlanCategoryLine = {
      ...summarized,
      sortOrder: source.sortOrder,
      groupId: source.groupId,
      groupName: source.groupName,
      groupSort: source.groupSort,
    };
    const id = source.groupId ?? UNGROUPED_SECTION_ID;
    const name = source.groupId ? groupLabel(source.groupName) : UNGROUPED_SECTION_NAME;
    const groupSort = source.groupId ? (source.groupSort ?? 0) : Number.MAX_SAFE_INTEGER;
    const bucket = buckets.get(id) ?? { id, name, groupSort, categories: [] };
    bucket.categories.push(line);
    buckets.set(id, bucket);
  }
  const sections = [...buckets.values()].sort(compareSections);
  for (const section of sections) {
    section.categories.sort((a, b) =>
      compareCatalogOrder(
        { id: a.categoryId, name: a.name, sortOrder: a.sortOrder },
        { id: b.categoryId, name: b.name, sortOrder: b.sortOrder },
      ),
    );
  }
  return ok(sections.map(({ id, name, categories }) => ({ id, name, categories })));
}

function groupLabel(name: string | null): string {
  const trimmed = name?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "Group";
}

function compareSections(a: { id: string; name: string; groupSort: number }, b: { id: string; name: string; groupSort: number }): number {
  if (a.groupSort !== b.groupSort) return a.groupSort - b.groupSort;
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  return a.id.localeCompare(b.id);
}
