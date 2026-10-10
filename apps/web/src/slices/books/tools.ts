import { answer, money, tool } from "@/slices/agents/tool-kit";
import { getHomeSummary, getSpendEstimate, getSpendingHistory } from "./service";

export const booksTools = [
  tool({
    name: "get_month_summary",
    title: "Get this month's summary",
    description:
      "The Home page numbers for the current month: income, spent, and left; total budgeted; the top spending categories against budget; total account balance; and the Spend estimate headline (the same numbers as get_spend_estimate). Integer cents.",
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
      "Spend estimate for the rest of this month and all of next month. It is an estimate, not a closed total. this_month: spent_so_far_cents + recurring_expected_cents (recurring items still due; paid ones are already in spent so far, missed ones are reported in recurring_missed_cents and not counted) + pace_cents (daily pace × pace_days left after today) = estimate_cents, plus income_so_far_cents, recurring_income_expected_cents, money_left_cents, and budget_cents / under_budget_cents when a Plan budget exists. next_month: the same with the whole month at pace. pace: daily_cents and its inputs (basis blended, pooled, or not_enough_history; this month's and the trailing 90 days' everyday spending, days, and daily averages; this month's weight percent). Everyday spending leaves out income, transfers, and transactions linked to recurring items. categories: per category, spent so far, recurring, pace, and estimate for both months. Integer cents; dates in the household's time zone.",
    access: "read",
    input: {},
    async run(_args, { books }) {
      return answer(await getSpendEstimate(books), (estimate) => {
        const head = `Spend estimate: about ${money(estimate.thisMonth.estimateCents, books)} this month (${money(estimate.thisMonth.spentSoFarCents, books)} so far) and ${money(estimate.nextMonth.estimateCents, books)} next month.`;
        return estimate.pace.basis === "not_enough_history"
          ? `${head} Not enough history yet for an everyday pace, so this is recurring items only.`
          : `${head} Everyday spending runs about ${money(estimate.pace.dailyCents, books)} a day.`;
      });
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
