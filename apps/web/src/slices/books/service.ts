import type { HistoryColumn, SpendEstimate } from "@dollas/domain";
import { failure, succeed, type ServiceResult } from "@/lib/service-result";
import type { BooksContext } from "@/slices/access/member";
import { loadHistory, loadHome, loadProjection } from "./queries";

/**
 * Read services for Home, History, and the spend projection, shared by those
 * pages and MCP tools. Results are integer cents.
 */

export type HomeSummary = Awaited<ReturnType<typeof loadHome>>;

export async function getHomeSummary(books: BooksContext): Promise<ServiceResult<HomeSummary>> {
  try {
    return succeed(await loadHome(books));
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

/** This month's spend so far and the projected month-end spend. */
export async function getSpendEstimate(books: BooksContext): Promise<ServiceResult<SpendEstimate>> {
  try {
    return succeed(await loadProjection(books));
  } catch (error) {
    return failure(error, "Could not load the spend estimate.", { action: "load-projection", householdId: books.householdId });
  }
}
