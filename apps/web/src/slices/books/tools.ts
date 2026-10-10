import { answer, money, tool } from "@/slices/agents/tool-kit";
import { getHomeSummary, getSpendEstimate, getSpendingHistory } from "./service";

export const booksTools = [
  tool({
    name: "get_month_summary",
    title: "Get this month's summary",
    description:
      "The Home page numbers for the current month: income, spent, and left; total budgeted; the top spending categories against budget; total account balance; and the month-end spend estimate. Integer cents.",
    access: "read",
    input: {},
    async run(_args, { books }) {
      return answer(
        await getHomeSummary(books),
        (home) => `Spent ${money(home.spentCents, books)} of ${money(home.incomeCents, books)} income this month.`,
      );
    },
  }),
  tool({
    name: "get_spend_estimate",
    title: "Get spend estimate",
    description:
      "Projection for the current month from the pace so far: spent_so_far_cents, estimate_cents at month end, daily_pace_cents, and days elapsed and remaining. An estimate, not a closed month.",
    access: "read",
    input: {},
    async run(_args, { books }) {
      return answer(
        await getSpendEstimate(books),
        (estimate) => `On pace to spend about ${money(estimate.estimateCents, books)} this month (${money(estimate.spentSoFarCents, books)} so far).`,
      );
    },
  }),
  tool({
    name: "get_spending_history",
    title: "Get spending history",
    description:
      "Twelve months of spending, oldest first, in integer cents, with month-over-month and year-over-year changes. The current month is partial and its year-over-year change is not comparable yet.",
    access: "read",
    input: {},
    async run(_args, { books }) {
      return answer(
        await getSpendingHistory(books),
        (columns) => `${columns.length} months of spending.`,
        (columns) => ({ months: columns }),
      );
    },
  }),
];
