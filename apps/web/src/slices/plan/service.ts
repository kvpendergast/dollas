import {
  BudgetError,
  clearCategoryBudget,
  copyPreviousMonthBudgets,
  formatBudgetMonth,
  listMonthPlan,
  parseBudgetMonth,
  previewCopyPreviousMonth,
  setCategoryBudget,
  type BudgetMonth,
  type CopyBudgetPreview,
  type CopyBudgetResult,
  type MonthPlan,
} from "@dollas/domain";
import { withActor } from "@/db/actor";
import { logInfo } from "@/lib/telemetry";
import { failure, refuse, succeed, type ServiceActor, type ServiceResult, type Via } from "@/lib/service-result";
import type { BooksContext } from "@/slices/access/member";
import { drizzleBudgetStore } from "./store";

/**
 * Monthly budget (Plan) services shared by the Plan page and MCP tools.
 * Months are "YYYY-MM"; amounts are non-negative integer cents.
 */

/** The month to show: the one asked for, or the household's current month. */
export function planMonth(books: Pick<BooksContext, "asOf">, raw?: string): ServiceResult<BudgetMonth> {
  if (!raw) return succeed({ year: books.asOf.year, month: books.asOf.month });
  const parsed = parseBudgetMonth(raw);
  if (parsed.isErr()) return refuse(parsed.error.message, parsed.error);
  return succeed(parsed.value);
}

async function run<T>(
  userId: string,
  action: string,
  fallback: string,
  attributes: Record<string, string>,
  work: (store: ReturnType<typeof drizzleBudgetStore>) => Promise<{ isErr(): boolean } & ({ value: T } | { error: unknown })>,
): Promise<ServiceResult<T>> {
  try {
    const result = await withActor(userId, (tx) => work(drizzleBudgetStore(tx)));
    if ("error" in result && result.isErr()) return failure(result.error, fallback, { action, ...attributes });
    return succeed((result as { value: T }).value);
  } catch (error) {
    return failure(error, fallback, { action, ...attributes });
  }
}

export async function getMonthPlan(books: BooksContext, month: BudgetMonth): Promise<ServiceResult<MonthPlan>> {
  return run(books.userId, "load-plan", "Could not load this month's plan.", { householdId: books.householdId }, (store) =>
    listMonthPlan(store, { householdId: books.householdId, month, asOf: books.asOf }),
  );
}

/** What copying last month's budgets into `month` would add and overwrite. Does not write. */
export async function previewCopyLastMonth(actor: ServiceActor, month: BudgetMonth): Promise<ServiceResult<CopyBudgetPreview>> {
  return run(actor.userId, "preview-copy-budgets", "Could not read last month's budgets.", { householdId: actor.householdId }, (store) =>
    previewCopyPreviousMonth(store, { householdId: actor.householdId, month }),
  );
}

export async function setBudget(
  actor: ServiceActor,
  input: { categoryId: string; month: BudgetMonth; amountCents: number },
  via: Via = "web",
): Promise<ServiceResult<{ categoryId: string; month: string; amountCents: number }>> {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents < 0) {
    return refuse("A budget is a whole number of cents, zero or more.", new BudgetError("amount"));
  }
  const saved = await run(actor.userId, "set-budget", "Could not save that budget.", { householdId: actor.householdId, via }, (store) =>
    setCategoryBudget(store, { householdId: actor.householdId, ...input }),
  );
  if (!saved.ok) return saved;
  logInfo("Budget set", { action: "set-budget", via, householdId: actor.householdId });
  return succeed({ categoryId: input.categoryId, month: formatBudgetMonth(input.month), amountCents: input.amountCents });
}

export async function clearBudget(
  actor: ServiceActor,
  input: { categoryId: string; month: BudgetMonth },
  via: Via = "web",
): Promise<ServiceResult<{ categoryId: string; month: string }>> {
  const cleared = await run(actor.userId, "set-budget", "Could not save that budget.", { householdId: actor.householdId, via }, (store) =>
    clearCategoryBudget(store, { householdId: actor.householdId, ...input }),
  );
  if (!cleared.ok) return cleared;
  logInfo("Budget cleared", { action: "clear-budget", via, householdId: actor.householdId });
  return succeed({ categoryId: input.categoryId, month: formatBudgetMonth(input.month) });
}

/** Copies last month's budgets into `month`. Overwriting budgets already set there needs `overwrite`. */
export async function copyLastMonth(
  actor: ServiceActor,
  input: { month: BudgetMonth; overwrite: boolean },
  via: Via = "web",
): Promise<ServiceResult<CopyBudgetResult>> {
  const copied = await run(actor.userId, "copy-budgets", "Could not copy last month's budgets.", { householdId: actor.householdId, via }, (store) =>
    copyPreviousMonthBudgets(store, { householdId: actor.householdId, month: input.month, confirmOverwrite: input.overwrite }),
  );
  if (copied.ok) logInfo("Budgets copied", { action: "copy-budgets", via, householdId: actor.householdId });
  return copied;
}
