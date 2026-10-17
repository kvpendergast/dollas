import type { HistoryColumn, SpendEstimate } from "@dollas/domain";
import { failure, refuse, succeed, type ServiceResult } from "@/lib/service-result";
import type { BooksContext } from "@/slices/access/member";
import { loadSpendEstimate } from "./estimate";
import { loadHistory, loadHome, loadHomeFor, parsePlanMonth } from "./queries";

/**
 * Read services for Home, History, and the Spend estimate, shared by those
 * pages and MCP tools. Results are integer cents.
 */

export type HomeSummary = Awaited<ReturnType<typeof loadHome>>;
export type MonthSummary = Awaited<ReturnType<typeof loadHomeFor>>;

/** The Home numbers for the current month, or for `month` (YYYY-MM) when given. */
export async function getHomeSummary(books: BooksContext, month?: string): Promise<ServiceResult<MonthSummary>> {
  const wanted = month === undefined ? null : parsePlanMonth(month);
  if (month !== undefined && !wanted) return refuse("Use a month like 2026-09.");
  try {
    return succeed(await loadHomeFor(books, wanted));
  } catch (error) {
    return failure(error, "Could not load this month's summary.", { action: "load-home", householdId: books.householdId });
  }
}

/** Twelve months of spending, oldest first. The current month is partial and not comparable yet. */
export async function getSpendingHistory(books: BooksContext): Promise<ServiceResult<HistoryColumn[]>> {
  try {
    return succeed(await loadHistory(books));
  } catch (error) {
    return failure(error, "Could not load spending history.", { action: "load-history", householdId: books.householdId });
  }
}

/**
 * Spend estimate for the rest of this month and all of next: spent so far,
 * recurring items still expected, and the pace of everyday spending, per
 * category. Home's estimate card shows the same numbers.
 */
export async function getSpendEstimate(books: BooksContext): Promise<ServiceResult<SpendEstimate>> {
  try {
    return succeed(await loadSpendEstimate(books));
  } catch (error) {
    return failure(error, "Could not load the spend estimate.", { action: "load-spend-estimate", householdId: books.householdId });
  }
}
