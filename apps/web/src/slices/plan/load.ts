import type { BudgetMonth, CopyBudgetPreview, MonthPlan } from "@dollas/domain";
import type { BooksContext } from "@/slices/access/guard";
import { getMonthPlan, previewCopyLastMonth } from "./service";

/** Page loaders over ./service. */

export async function loadMonthPlan(books: BooksContext, month: BudgetMonth): Promise<MonthPlan> {
  const plan = await getMonthPlan(books, month);
  if (!plan.ok) throw new Error(plan.memberMessage);
  return plan.value;
}

export async function loadCopyPreview(
  books: BooksContext,
  month: BudgetMonth,
): Promise<{ preview: CopyBudgetPreview | null; error: string }> {
  const preview = await previewCopyLastMonth(books, month);
  return preview.ok ? { preview: preview.value, error: "" } : { preview: null, error: preview.memberMessage };
}
