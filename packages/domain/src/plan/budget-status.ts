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
