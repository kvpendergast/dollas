export type BudgetStanding = "over" | "within" | "unbudgeted";

export function budgetStanding(spentCents: number, budgetCents: number | null): BudgetStanding {
  if (budgetCents === null) return "unbudgeted";
  if (spentCents > budgetCents) return "over";
  return "within";
}

export type CategoryMonth = {
  categoryId: string;
  name: string;
  spentCents: number;
  budgetCents: number | null;
  standing: BudgetStanding;
  remainingCents: number | null;
};

export function summarizeCategoryMonth(input: {
  categoryId: string;
  name: string;
  spentCents: number;
  budgetCents: number | null;
}): CategoryMonth {
  const standing = budgetStanding(input.spentCents, input.budgetCents);
  return {
    ...input,
    standing,
    remainingCents: input.budgetCents === null ? null : input.budgetCents - input.spentCents,
  };
}

export type PlanSoFar = {
  /** At least one category has a budget this month. */
  hasBudget: boolean;
  budgetedCents: number;
  /** Spending in budgeted categories (what counts against the plan). */
  spentInPlanCents: number;
  /** Every budgeted category, including ones with nothing spent ($0 of $X); largest budget first. */
  budgeted: CategoryMonth[];
  /** Categories with spending and no budget; most spent first. */
  unbudgeted: CategoryMonth[];
};

/**
 * Home's "The plan so far" (PEN-212): spent against budget for every budgeted
 * category, so a budgeted category with no spending still shows, plus spending
 * outside the plan. With no budget it is just spending by category.
 */
export function planSoFar(input: {
  spent: readonly { categoryId: string; name: string; spentCents: number }[];
  budgets: readonly { categoryId: string; name: string; budgetCents: number }[];
}): PlanSoFar {
  const spentById = new Map(input.spent.map((row) => [row.categoryId, row.spentCents] as const));
  const budgetIds = new Set(input.budgets.map((row) => row.categoryId));
  const budgeted = input.budgets
    .map((row) => summarizeCategoryMonth({ categoryId: row.categoryId, name: row.name, spentCents: spentById.get(row.categoryId) ?? 0, budgetCents: row.budgetCents }))
    .sort((a, b) => (b.budgetCents ?? 0) - (a.budgetCents ?? 0) || a.name.localeCompare(b.name));
  const unbudgeted = input.spent
    .filter((row) => !budgetIds.has(row.categoryId) && row.spentCents > 0)
    .map((row) => summarizeCategoryMonth({ ...row, budgetCents: null }))
    .sort((a, b) => b.spentCents - a.spentCents || a.name.localeCompare(b.name));
  return {
    hasBudget: budgeted.length > 0,
    budgetedCents: budgeted.reduce((sum, row) => sum + (row.budgetCents ?? 0), 0),
    spentInPlanCents: budgeted.reduce((sum, row) => sum + row.spentCents, 0),
    budgeted,
    unbudgeted,
  };
}
