import { formatBudgetMonth, type MonthPlan } from "@dollas/domain";
import { z } from "zod";
import { answer, centsInput, money, plural, tool, uuidInput, monthInput } from "@/slices/agents/tool-kit";
import { clearBudget, copyLastMonth, getMonthPlan, planMonth, previewCopyLastMonth, setBudget } from "./service";

function planOut(plan: MonthPlan) {
  return {
    month: formatBudgetMonth(plan.month),
    income_cents: plan.incomeCents,
    sections: plan.sections,
  };
}

export const planTools = [
  tool({
    name: "get_plan",
    title: "Get monthly plan",
    description:
      "The monthly budget (Plan) for one month: income and, per group, each expense category's budget, spending, and what is left, in integer cents. Pass month to switch months.",
    access: "read",
    input: { month: monthInput.optional() },
    async run(args, { books }) {
      const month = planMonth(books, args.month);
      if (!month.ok) return { ok: false, message: month.memberMessage };
      return answer(
        await getMonthPlan(books, month.value),
        (plan) => `Plan for ${formatBudgetMonth(plan.month)}: ${plural(plan.sections.length, "group")}, income ${money(plan.incomeCents, books)}.`,
        planOut,
      );
    },
  }),
  tool({
    name: "set_budget",
    title: "Set budget",
    description: "Set an expense category's budget for a month, in integer cents (zero or more).",
    access: "write",
    idempotent: true,
    input: { category_id: uuidInput("Expense category"), amount_cents: centsInput("Budget").min(0), month: monthInput.optional() },
    async run(args, { books }) {
      const month = planMonth(books, args.month);
      if (!month.ok) return { ok: false, message: month.memberMessage };
      const saved = await setBudget(books, { categoryId: args.category_id, month: month.value, amountCents: args.amount_cents }, "mcp");
      return answer(saved, (value) => `Budget set to ${money(value.amountCents, books)} for ${value.month}.`, (value) => ({
        category_id: value.categoryId,
        month: value.month,
        amount_cents: value.amountCents,
      }));
    },
  }),
  tool({
    name: "clear_budget",
    title: "Clear budget",
    description: "Remove an expense category's budget for a month.",
    access: "write",
    idempotent: true,
    input: { category_id: uuidInput("Expense category"), month: monthInput.optional() },
    async run(args, { books }) {
      const month = planMonth(books, args.month);
      if (!month.ok) return { ok: false, message: month.memberMessage };
      return answer(await clearBudget(books, { categoryId: args.category_id, month: month.value }, "mcp"), (value) => `Cleared the budget for ${value.month}.`, (value) => ({
        category_id: value.categoryId,
        month: value.month,
      }));
    },
  }),
  tool({
    name: "preview_copy_last_month",
    title: "Preview copying last month's budgets",
    description: "What copy_last_month would add to a month and which budgets already set there it would overwrite. Nothing is written.",
    access: "read",
    input: { month: monthInput.optional() },
    async run(args, { books }) {
      const month = planMonth(books, args.month);
      if (!month.ok) return { ok: false, message: month.memberMessage };
      return answer(await previewCopyLastMonth(books, month.value), () => `Copy preview for ${formatBudgetMonth(month.value)}.`, (value) => ({
        ...value,
        from: formatBudgetMonth(value.from),
      }));
    },
  }),
  tool({
    name: "copy_last_month",
    title: "Copy last month's budgets",
    description:
      "Copy the previous month's budgets into a month. If that month already has budgets that would change, it refuses unless overwrite is true (ask the member first).",
    access: "write",
    input: {
      month: monthInput.optional(),
      overwrite: z.boolean().optional().describe("Replace budgets already set in the month."),
    },
    async run(args, { books }) {
      const month = planMonth(books, args.month);
      if (!month.ok) return { ok: false, message: month.memberMessage };
      return answer(
        await copyLastMonth(books, { month: month.value, overwrite: args.overwrite === true }, "mcp"),
        (value) => `Copied ${plural(value.copied.length, "budget")}${value.overwritten.length ? `, overwrote ${value.overwritten.length}` : ""}.`,
      );
    },
  }),
];

