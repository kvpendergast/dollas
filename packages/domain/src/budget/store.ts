import type { BudgetMonth } from "./month";

/** Expense, income, and transfer categories the plan may filter. */
export type BudgetCategory = {
  id: string;
  householdId: string;
  name: string;
  kind: string;
  sortOrder: number;
  groupId: string | null;
  groupName: string | null;
  groupSort: number | null;
};

export type StoredBudget = {
  categoryId: string;
  amountCents: number;
};

export type SpendSplit = {
  categoryId: string;
  kind: string;
  amountCents: number;
};

/**
 * Household-scoped budget reads and writes.
 * Implementations run inside the app role transaction and throw on driver failure.
 * Callers show members a mapped sentence, not the thrown driver text.
 */
export type BudgetStore = {
  listCategories(householdId: string): Promise<readonly BudgetCategory[]>;
  findCategory(householdId: string, categoryId: string): Promise<BudgetCategory | null>;
  listBudgets(householdId: string, month: BudgetMonth): Promise<readonly StoredBudget[]>;
  listSpending(householdId: string, range: { start: string; end: string }): Promise<readonly SpendSplit[]>;
  upsertBudget(input: {
    householdId: string;
    categoryId: string;
    month: BudgetMonth;
    amountCents: number;
  }): Promise<void>;
  deleteBudget(input: { householdId: string; categoryId: string; month: BudgetMonth }): Promise<void>;
};
