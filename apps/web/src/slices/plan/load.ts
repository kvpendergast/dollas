import type { BudgetMonth, PnlGranularity, ProfitLoss, CopyBudgetPreview, MonthPlan } from "@dollas/domain";
import type { BooksContext } from "@/slices/access/guard";
import { getMonthPlan, previewCopyLastMonth } from "./service";
import { getProfitAndLoss } from "./profit-loss";

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

export async function loadProfitAndLoss(
  books: BooksContext,
  input: { fromMonth?: string; toMonth?: string; granularity: PnlGranularity },
): Promise<ProfitLoss> {
  const report = await getProfitAndLoss(books, input);
  if (!report.ok) throw new Error(report.memberMessage);
  return report.value;
}
