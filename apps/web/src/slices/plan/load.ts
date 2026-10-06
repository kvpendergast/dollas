import {
  DomainError,
  listMonthPlan,
  memberFacingMessage,
  previewCopyPreviousMonth,
  type BudgetMonth,
  type CopyBudgetPreview,
  type MonthPlan,
} from "@dollas/domain";
import { withActor } from "@/db/actor";
import { logError } from "@/lib/telemetry";
import type { BooksContext } from "@/slices/access/guard";
import { drizzleBudgetStore } from "./store";

const LOAD_FALLBACK = "Could not load this month's plan.";
const COPY_FALLBACK = "Could not read last month's budgets.";

export async function loadMonthPlan(books: BooksContext, month: BudgetMonth): Promise<MonthPlan> {
  let result: Awaited<ReturnType<typeof listMonthPlan>>;
  try {
    result = await withActor(books.userId, (tx) =>
      listMonthPlan(drizzleBudgetStore(tx), {
        householdId: books.householdId,
        month,
        asOf: books.asOf,
      }),
    );
  } catch (error) {
    logError(error, { action: "load-plan", householdId: books.householdId });
    throw new Error(LOAD_FALLBACK);
  }
  if (result.isErr()) {
    logError(result.error, { action: "load-plan", householdId: books.householdId });
    throw new Error(shown(result.error, LOAD_FALLBACK));
  }
  return result.value;
}

export async function loadCopyPreview(
  books: BooksContext,
  month: BudgetMonth,
): Promise<{ preview: CopyBudgetPreview | null; error: string }> {
  try {
    const result = await withActor(books.userId, (tx) =>
      previewCopyPreviousMonth(drizzleBudgetStore(tx), {
        householdId: books.householdId,
        month,
      }),
    );
    if (result.isErr()) {
      logError(result.error, { action: "preview-copy-budgets", householdId: books.householdId });
      return { preview: null, error: shown(result.error, COPY_FALLBACK) };
    }
    return { preview: result.value, error: "" };
  } catch (error) {
    logError(error, { action: "preview-copy-budgets", householdId: books.householdId });
    return { preview: null, error: COPY_FALLBACK };
  }
}

function shown(error: unknown, fallback: string): string {
  if (error instanceof DomainError) return memberFacingMessage(error, fallback);
  return fallback;
}
