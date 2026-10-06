import { err, ok, type Result } from "neverthrow";
import { BudgetError, type DomainError } from "../errors";
import { categoryBooksEffect } from "../categories/define";
import { toIsoDate } from "../dates";
import type { CivilDate } from "../history/columns";
import { assertCents } from "../money/cents";
import { classifyPreviousBudgets, type ClassifiedCopy, type CopyBudgetLine } from "./copy";
import { assertBudgetMonth, planThroughDate, shiftBudgetMonth, type BudgetMonth } from "./month";
import { planSections, type PlanSection } from "./sections";
import type { BudgetStore } from "./store";

export type { BudgetAmountDecision } from "./amount";
export { decideBudgetAmount } from "./amount";
export type { CopyBudgetLine } from "./copy";
export type { BudgetMonth } from "./month";
export { formatBudgetMonth, parseBudgetMonth, planThroughDate, shiftBudgetMonth } from "./month";
export type { PlanCategoryLine, PlanSection } from "./sections";
export { planSections, UNGROUPED_SECTION_ID, UNGROUPED_SECTION_NAME } from "./sections";
export type { BudgetCategory, BudgetStore, SpendSplit, StoredBudget } from "./store";

export type MonthPlan = {
  month: BudgetMonth;
  incomeCents: number;
  sections: PlanSection[];
};

export type CopyBudgetPreview = ClassifiedCopy & {
  from: BudgetMonth;
};

export type CopyBudgetResult = {
  copied: readonly CopyBudgetLine[];
  overwritten: readonly CopyBudgetLine[];
};

/**
 * Expense categories for one month, sectioned by group, with spending bounded to that month.
 */
export async function listMonthPlan(
  store: BudgetStore,
  input: { householdId: string; month: BudgetMonth; asOf: CivilDate },
): Promise<Result<MonthPlan, DomainError>> {
  const month = assertBudgetMonth(input.month);
  if (month.isErr()) return err(month.error);
  const through = planThroughDate(month.value, input.asOf);
  const categories = await store.listCategories(input.householdId);
  const budgets = await store.listBudgets(input.householdId, month.value);
  const spending = await store.listSpending(input.householdId, {
    start: toIsoDate({ year: month.value.year, month: month.value.month, day: 1 }),
    end: toIsoDate(through),
  });
  const budgetByCategory = new Map<string, number>();
  for (const row of budgets) {
    const amount = nonNegativeCents(row.amountCents);
    if (amount.isErr()) return err(amount.error);
    budgetByCategory.set(row.categoryId, amount.value);
  }
  const spent = new Map<string, number>();
  let incomeCents = 0;
  for (const split of spending) {
    const effect = categoryBooksEffect(split.kind, split.amountCents);
    if (effect.isErr()) return err(effect.error);
    incomeCents += effect.value.incomeCents;
    if (effect.value.spentCents === 0) continue;
    spent.set(split.categoryId, (spent.get(split.categoryId) ?? 0) + effect.value.spentCents);
  }
  const sections = planSections(
    categories
      .filter((row) => row.householdId === input.householdId)
      .map((row) => ({
        categoryId: row.id,
        name: row.name,
        kind: row.kind,
        sortOrder: row.sortOrder,
        groupId: row.groupId,
        groupName: row.groupName,
        groupSort: row.groupSort,
        spentCents: spent.get(row.id) ?? 0,
        budgetCents: budgetByCategory.get(row.id) ?? null,
      })),
  );
  if (sections.isErr()) return err(sections.error);
  return ok({ month: month.value, incomeCents, sections: sections.value });
}

/** Save an expense category's budget for one month. Zero is a budget. Blank is a clear. */
export async function setCategoryBudget(
  store: BudgetStore,
  input: { householdId: string; categoryId: string; month: BudgetMonth; amountCents: number },
): Promise<Result<void, DomainError>> {
  const ready = await readyExpense(store, input.householdId, input.categoryId, input.month);
  if (ready.isErr()) return err(ready.error);
  const amount = nonNegativeCents(input.amountCents);
  if (amount.isErr()) return err(amount.error);
  await store.upsertBudget({
    householdId: input.householdId,
    categoryId: input.categoryId,
    month: ready.value,
    amountCents: amount.value,
  });
  return ok(undefined);
}

/** Remove the month's budget so the category is unbudgeted again. */
export async function clearCategoryBudget(
  store: BudgetStore,
  input: { householdId: string; categoryId: string; month: BudgetMonth },
): Promise<Result<void, DomainError>> {
  const ready = await readyExpense(store, input.householdId, input.categoryId, input.month);
  if (ready.isErr()) return err(ready.error);
  await store.deleteBudget({
    householdId: input.householdId,
    categoryId: input.categoryId,
    month: ready.value,
  });
  return ok(undefined);
}

/** What copying last month would add, and what it would replace. */
export async function previewCopyPreviousMonth(
  store: BudgetStore,
  input: { householdId: string; month: BudgetMonth },
): Promise<Result<CopyBudgetPreview, DomainError>> {
  const classified = await readCopy(store, input.householdId, input.month);
  if (classified.isErr()) return err(classified.error);
  return ok({ from: classified.value.from, ...classified.value.classified });
}

/**
 * Copy last month's expense budgets into this month.
 * Budgets already set this month stay put unless `confirmOverwrite` is set.
 */
export async function copyPreviousMonthBudgets(
  store: BudgetStore,
  input: { householdId: string; month: BudgetMonth; confirmOverwrite: boolean },
): Promise<Result<CopyBudgetResult, DomainError>> {
  const classified = await readCopy(store, input.householdId, input.month);
  if (classified.isErr()) return err(classified.error);
  const plan = classified.value.classified;
  if (plan.copies.length === 0 && plan.overwrites.length === 0) {
    return err(
      new BudgetError(
        plan.unchangedCount > 0 ? "This month already matches last month." : "Last month has no budgets to copy.",
      ),
    );
  }
  if (plan.copies.length === 0 && !input.confirmOverwrite) {
    return err(new BudgetError("Confirm overwrite to replace budgets already set this month."));
  }
  const month = assertBudgetMonth(input.month);
  if (month.isErr()) return err(month.error);
  for (const line of plan.copies) {
    await store.upsertBudget({
      householdId: input.householdId,
      categoryId: line.categoryId,
      month: month.value,
      amountCents: line.previousCents,
    });
  }
  const overwritten = input.confirmOverwrite ? plan.overwrites : [];
  for (const line of overwritten) {
    await store.upsertBudget({
      householdId: input.householdId,
      categoryId: line.categoryId,
      month: month.value,
      amountCents: line.previousCents,
    });
  }
  return ok({ copied: plan.copies, overwritten });
}

async function readCopy(
  store: BudgetStore,
  householdId: string,
  month: BudgetMonth,
): Promise<Result<{ from: BudgetMonth; classified: ClassifiedCopy }, DomainError>> {
  const target = assertBudgetMonth(month);
  if (target.isErr()) return err(target.error);
  const from = shiftBudgetMonth(target.value, -1);
  if (from.isErr()) return err(new BudgetError("There is no earlier month to copy."));
  const categories = (await store.listCategories(householdId)).filter((row) => row.householdId === householdId);
  const [previous, current] = [
    await store.listBudgets(householdId, from.value),
    await store.listBudgets(householdId, target.value),
  ];
  const classified = classifyPreviousBudgets({ categories, previous, current });
  if (classified.isErr()) return err(classified.error);
  return ok({ from: from.value, classified: classified.value });
}

async function readyExpense(
  store: BudgetStore,
  householdId: string,
  categoryId: string,
  month: BudgetMonth,
): Promise<Result<BudgetMonth, DomainError>> {
  const target = assertBudgetMonth(month);
  if (target.isErr()) return err(target.error);
  const category = await store.findCategory(householdId, categoryId);
  if (!category || category.householdId !== householdId) {
    return err(new BudgetError("That category is not in this household."));
  }
  if (category.kind !== "expense") return err(new BudgetError("Plan budgets are for expense categories."));
  return ok(target.value);
}

function nonNegativeCents(amountCents: number): Result<number, DomainError> {
  const cents = assertCents(amountCents);
  if (cents.isErr()) return err(cents.error);
  if (cents.value < 0) return err(new BudgetError("A budget cannot be negative."));
  return ok(cents.value);
}
