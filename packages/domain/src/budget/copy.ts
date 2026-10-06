import { err, ok, type Result } from "neverthrow";
import { BudgetError } from "../errors";
import { assertCents } from "../money/cents";
import { compareCatalogOrder } from "../categories/organize";
import type { BudgetCategory, StoredBudget } from "./store";

export type CopyBudgetLine = {
  categoryId: string;
  name: string;
  groupName: string | null;
  previousCents: number;
  currentCents: number | null;
};

export type ClassifiedCopy = {
  copies: CopyBudgetLine[];
  overwrites: CopyBudgetLine[];
  unchangedCount: number;
};

/**
 * Last month fills categories that have no budget yet.
 * A category that already has a budget this month is an overwrite, even when the amount is zero.
 * Matching amounts are left off both lists.
 */
export function classifyPreviousBudgets(input: {
  categories: readonly BudgetCategory[];
  previous: readonly StoredBudget[];
  current: readonly StoredBudget[];
}): Result<ClassifiedCopy, BudgetError> {
  const expense = new Map(input.categories.filter((row) => row.kind === "expense").map((row) => [row.id, row]));
  const currentByCategory = new Map<string, number>();
  for (const row of input.current) {
    const amount = assertBudgetAmount(row.amountCents);
    if (amount.isErr()) return err(amount.error);
    if (!expense.has(row.categoryId)) continue;
    currentByCategory.set(row.categoryId, amount.value);
  }

  const copies: CopyBudgetLine[] = [];
  const overwrites: CopyBudgetLine[] = [];
  let unchangedCount = 0;
  const seen = new Set<string>();
  for (const row of input.previous) {
    if (seen.has(row.categoryId)) return err(new BudgetError("Could not read last month's budgets."));
    seen.add(row.categoryId);
    const category = expense.get(row.categoryId);
    if (!category) continue;
    const previousCents = assertBudgetAmount(row.amountCents);
    if (previousCents.isErr()) return err(previousCents.error);
    const currentCents = currentByCategory.get(row.categoryId) ?? null;
    if (currentCents === previousCents.value) {
      unchangedCount += 1;
      continue;
    }
    const line: CopyBudgetLine = {
      categoryId: category.id,
      name: category.name,
      groupName: category.groupId ? category.groupName : null,
      previousCents: previousCents.value,
      currentCents,
    };
    if (currentCents === null) copies.push(line);
    else overwrites.push(line);
  }

  const order = compareLines(input.categories);
  copies.sort(order);
  overwrites.sort(order);
  return ok({ copies, overwrites, unchangedCount });
}

function assertBudgetAmount(amountCents: number): Result<number, BudgetError> {
  const cents = assertCents(amountCents);
  if (cents.isErr() || cents.value < 0) return err(new BudgetError("A budget cannot be negative."));
  return ok(cents.value);
}

function compareLines(categories: readonly BudgetCategory[]) {
  const byId = new Map(categories.map((row) => [row.id, row]));
  return (a: CopyBudgetLine, b: CopyBudgetLine) => {
    const left = byId.get(a.categoryId);
    const right = byId.get(b.categoryId);
    if (!left || !right) return a.name.localeCompare(b.name);
    const leftSort = left.groupId ? (left.groupSort ?? 0) : Number.MAX_SAFE_INTEGER;
    const rightSort = right.groupId ? (right.groupSort ?? 0) : Number.MAX_SAFE_INTEGER;
    if (leftSort !== rightSort) return leftSort - rightSort;
    const byGroup = (left.groupName ?? "").localeCompare(right.groupName ?? "");
    if (byGroup !== 0) return byGroup;
    return compareCatalogOrder(left, right);
  };
}
