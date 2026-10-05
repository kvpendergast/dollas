import { err, ok, type Result } from "neverthrow";
import { InvalidCategoryError } from "../errors";
import { categoryKindLabel, isCategoryKind, type CategoryKind } from "./define";
import type { CategoryCatalog } from "./organize";

/**
 * Shown wherever someone picks a category kind.
 * A transfer is money moving between the household's own accounts.
 */
export const TRANSFER_KIND_HELP =
  "A transfer moves money between your own accounts and does not count as income or spending.";

export type CategoryKindChange = {
  catalog: CategoryCatalog;
  /**
   * When set, every budget row for this category is deleted.
   * Plan only lists expense categories, and the home budgeted total sums
   * every budget for the month, so leaving those rows in place would keep
   * the category on the budgeted total after it left Plan.
   */
  removeBudgetsFor: string | null;
};

export type KindChangeWarningInput = {
  name: string;
  currentKind: string;
  nextKind: string;
  budgetCount: number;
};

/**
 * Warning shown before a kind change is saved.
 * Budgets are removed, not kept hidden. Null when the save needs no confirmation.
 */
export function categoryKindChangeWarning(input: KindChangeWarningInput): string | null {
  if (!isCategoryKind(input.currentKind) || !isCategoryKind(input.nextKind)) return null;
  if (input.currentKind === input.nextKind) return null;
  if (!Number.isSafeInteger(input.budgetCount) || input.budgetCount <= 0) return null;
  if (input.nextKind === "expense") return null;
  return kindChangeWarning(input.name, input.currentKind, input.nextKind);
}

function kindChangeWarning(name: string, currentKind: CategoryKind, nextKind: CategoryKind): string {
  return `Changing ${name} from ${categoryKindLabel(currentKind)} to ${categoryKindLabel(nextKind)} moves it off Plan. Its budgets will be removed.`;
}

/**
 * Change the kind of one category in this household.
 * Expense categories carry the month's budgets on Plan. Moving one to income
 * or transfer takes it off Plan, so its budgets are removed once the member
 * confirms. Without that confirmation the catalog stays as it was.
 * Another household's category is left alone.
 */
export function changeCategoryKind(
  catalog: CategoryCatalog,
  householdId: string,
  categoryId: string,
  kind: string,
  budgetCount: number,
  confirmBudgetRemoval: boolean,
): Result<CategoryKindChange, InvalidCategoryError> {
  if (!isCategoryKind(kind)) {
    return err(new InvalidCategoryError("Choose income, expense, or transfer."));
  }
  if (!Number.isSafeInteger(budgetCount) || budgetCount < 0) {
    return err(new InvalidCategoryError("Budget count is not valid."));
  }
  const category = catalog.categories.find((row) => row.id === categoryId);
  if (!category || category.householdId !== householdId) {
    return err(new InvalidCategoryError("Choose a category in this household."));
  }
  if (!isCategoryKind(category.kind)) {
    return err(new InvalidCategoryError("Choose income, expense, or transfer."));
  }
  if (category.kind === kind) return ok({ catalog, removeBudgetsFor: null });
  const warning = categoryKindChangeWarning({
    name: category.name,
    currentKind: category.kind,
    nextKind: kind,
    budgetCount,
  });
  if (warning && !confirmBudgetRemoval) return err(new InvalidCategoryError(warning));
  return ok({
    catalog: {
      groups: catalog.groups,
      categories: catalog.categories.map((row) => (row.id === categoryId ? { ...row, kind } : row)),
    },
    removeBudgetsFor: warning ? categoryId : null,
  });
}
