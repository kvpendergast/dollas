import { buildProfitLoss, type PnlGranularity, type ProfitLoss } from "@dollas/domain";
import { withActor } from "@/db/actor";
import { failure, type ServiceResult } from "@/lib/service-result";
import type { BooksContext } from "@/slices/access/member";
import { drizzleProfitLossStore } from "./profit-loss-store";

/**
 * Month-over-month profit and loss for the signed-in household (page and MCP tool share this).
 * Household comes from the session or access token (`books`); reads run through household RLS.
 */
export async function getProfitAndLoss(
  books: BooksContext,
  input: { fromMonth?: string; toMonth?: string; granularity?: PnlGranularity },
): Promise<ServiceResult<ProfitLoss>> {
  const current = `${String(books.asOf.year).padStart(4, "0")}-${String(books.asOf.month).padStart(2, "0")}`;
  const toMonth = input.toMonth ?? current;
  const granularity = input.granularity ?? "month";
  // Default window: the 6 months ending at toMonth (YTD starts in January on its own).
  const fromMonth = input.fromMonth ?? shiftMonthText(toMonth, -5);
  try {
    const result = await withActor(books.userId, (tx) =>
      buildProfitLoss(drizzleProfitLossStore(tx), { householdId: books.householdId, fromMonth, toMonth, granularity, asOf: books.asOf }),
    );
    if (result.isErr()) return { ok: false, error: result.error, memberMessage: result.error.message };
    return { ok: true, value: result.value };
  } catch (error) {
    return failure(error, "Could not load the profit and loss.", { action: "profit-and-loss", householdId: books.householdId });
  }
}

function shiftMonthText(month: string, delta: number): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month; // the domain rejects it with a member-facing message
  const total = Number(match[1]) * 12 + (Number(match[2]) - 1) + delta;
  return `${String(Math.floor(total / 12)).padStart(4, "0")}-${String((total % 12) + 1).padStart(2, "0")}`;
}
