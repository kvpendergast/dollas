import { err, ok, type Result } from "neverthrow";
import { isCategoryKind } from "../categories/define";
import { compareCatalogOrder } from "../categories/organize";
import { BudgetError, type DomainError } from "../errors";
import type { CivilDate } from "../history/columns";
import { assertCents } from "../money/cents";
import { UNGROUPED_SECTION_ID, UNGROUPED_SECTION_NAME } from "../budget/sections";
import { formatBudgetMonth, parseBudgetMonth, planThroughDate, type BudgetMonth } from "../budget/month";

/**
 * Month-over-month profit and loss.
 *
 * Rules (see PEN profit-and-loss spec):
 * - Months are plan months: calendar months by transaction date, the current month counts
 *   through today only (planThroughDate), exactly like Plan and Home.
 * - Transfers are always out: any split in a transfer-kind category (the Transfers category and
 *   both legs of a linked transfer) is ignored.
 * - Expense categories: actual = spending net of refunds (outflows minus inflows), so a refund
 *   is negative and lowers the actual (the category can go below zero). Income categories:
 *   actual = inflows minus outflows. Home ignores refunds; this report nets them on purpose.
 * - Budgets exist per category per month (Plan has no recurring or carried-forward budgets).
 *   A month with no budget row is unbudgeted. Only expense categories carry budgets; income is
 *   actual-only.
 * - Status (expense categories only): "under" when actual <= budget (exactly at budget is under),
 *   "over" when actual > budget, "neutral" with no budget.
 * - Quarters roll up the monthly budgets by summing the months that have one (budget is null if
 *   none do). `budgeted_months` says how many of the period's months had a budget so a partly
 *   budgeted period is visible.
 * All amounts are integer cents.
 */

export const PNL_MAX_MONTHS = 36;

export type PnlGranularity = "month" | "quarter" | "ytd";
export type PnlStatus = "under" | "over" | "neutral";

export type PnlPeriod = {
  /** "2026-03", "2026-Q1", or "2026-ytd". */
  key: string;
  label: string;
  /** First and last month included, YYYY-MM. Quarters at the edge of the range are clipped. */
  from: string;
  to: string;
  months: number;
  /** The period ends in the current, unfinished month. */
  partial: boolean;
};

export type PnlCell = {
  actualCents: number;
  budgetCents: number | null;
  /** actual minus budget (positive is over), null when unbudgeted. */
  deltaCents: number | null;
  /** Months in the period that had a budget for this category. */
  budgetedMonths: number;
  status: PnlStatus;
};

export type PnlCategoryRow = {
  id: string;
  name: string;
  kind: "income" | "expense";
  periods: PnlCell[];
};

export type PnlGroup = {
  id: string;
  name: string;
  categories: PnlCategoryRow[];
};

export type PnlTotals = {
  incomeCents: number;
  expensesCents: number;
  netCents: number;
  /** Sum of expense budgets set in the period; null when no expense category is budgeted. */
  budgetExpensesCents: number | null;
  /** Spending in the budgeted categories and months only, to compare with budgetExpensesCents. */
  budgetedActualCents: number;
};

export type ProfitLoss = {
  granularity: PnlGranularity;
  from: string;
  to: string;
  periods: PnlPeriod[];
  groups: PnlGroup[];
  totals: PnlTotals[];
};

export type PnlCategory = {
  id: string;
  householdId: string;
  name: string;
  kind: string;
  sortOrder: number;
  groupId: string | null;
  groupName: string | null;
  groupSort: number | null;
};

export type PnlSplit = { categoryId: string; kind: string; amountCents: number; occurredOn: string };
export type PnlBudget = { categoryId: string; year: number; month: number; amountCents: number };

/** Household-scoped reads. Implementations run under RLS; `listSplits` skips deleted transactions. */
export type PnlStore = {
  listCategories(householdId: string): Promise<readonly PnlCategory[]>;
  listBudgets(householdId: string, range: { from: BudgetMonth; to: BudgetMonth }): Promise<readonly PnlBudget[]>;
  listSplits(householdId: string, range: { start: string; end: string }): Promise<readonly PnlSplit[]>;
};

export type PnlInput = {
  householdId: string;
  fromMonth: string;
  toMonth: string;
  granularity: PnlGranularity;
  asOf: CivilDate;
};

const iso = (d: CivilDate) => `${String(d.year).padStart(4, "0")}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
const index = (month: BudgetMonth) => month.year * 12 + (month.month - 1);
const fromIndex = (value: number): BudgetMonth => ({ year: Math.floor(value / 12), month: (value % 12) + 1 });

type Bucket = { key: string; label: string; first: number; last: number };

function buildBuckets(granularity: PnlGranularity, first: number, last: number): Bucket[] {
  const buckets: Bucket[] = [];
  if (granularity === "month") {
    for (let i = first; i <= last; i++) buckets.push({ key: formatBudgetMonth(fromIndex(i)), label: formatBudgetMonth(fromIndex(i)), first: i, last: i });
    return buckets;
  }
  const size = granularity === "quarter" ? 3 : 12;
  let start = first;
  while (start <= last) {
    const month = fromIndex(start);
    const unitStart = granularity === "quarter" ? month.year * 12 + Math.floor((month.month - 1) / 3) * 3 : month.year * 12;
    const unitEnd = unitStart + size - 1;
    const end = Math.min(unitEnd, last);
    if (granularity === "quarter") {
      const q = Math.floor((month.month - 1) / 3) + 1;
      buckets.push({ key: `${month.year}-Q${q}`, label: `Q${q} ${month.year}`, first: start, last: end });
    } else {
      buckets.push({ key: `${month.year}-ytd`, label: end === unitEnd ? `${month.year}` : `${month.year} YTD`, first: start, last: end });
    }
    start = end + 1;
  }
  return buckets;
}

export function profitLossStatus(actualCents: number, budgetCents: number | null): PnlStatus {
  if (budgetCents === null) return "neutral";
  return actualCents > budgetCents ? "over" : "under";
}

export async function buildProfitLoss(store: PnlStore, input: PnlInput): Promise<Result<ProfitLoss, DomainError>> {
  if (!["month", "quarter", "ytd"].includes(input.granularity)) return err(new BudgetError("Choose months, quarters, or year to date."));
  const from = parseBudgetMonth(input.fromMonth);
  if (from.isErr()) return err(from.error);
  const to = parseBudgetMonth(input.toMonth);
  if (to.isErr()) return err(to.error);
  let firstIndex = index(from.value);
  const lastIndex = index(to.value);
  if (lastIndex < firstIndex) return err(new BudgetError("The end month comes before the start month."));
  // Year to date always starts in January of the first year.
  if (input.granularity === "ytd") firstIndex = from.value.year * 12;
  if (lastIndex - firstIndex + 1 > PNL_MAX_MONTHS) return err(new BudgetError(`Choose at most ${PNL_MAX_MONTHS} months.`));
  const firstMonth = fromIndex(firstIndex);
  const lastMonth = to.value;

  const through = planThroughDate(lastMonth, input.asOf);
  const [categories, budgets, splits] = await Promise.all([
    store.listCategories(input.householdId),
    store.listBudgets(input.householdId, { from: firstMonth, to: lastMonth }),
    store.listSplits(input.householdId, { start: iso({ year: firstMonth.year, month: firstMonth.month, day: 1 }), end: iso(through) }),
  ]);

  const buckets = buildBuckets(input.granularity, firstIndex, lastIndex);
  const bucketOf = (monthIndex: number) => buckets.findIndex((bucket) => monthIndex >= bucket.first && monthIndex <= bucket.last);
  const own = categories.filter((row) => row.householdId === input.householdId);
  const byId = new Map(own.map((row) => [row.id, row] as const));

  // actual[categoryId][bucket], budget sums and counts
  const actual = new Map<string, number[]>();
  const budgetSum = new Map<string, number[]>();
  const budgetCount = new Map<string, number[]>();
  const slot = (map: Map<string, number[]>, id: string) => {
    let row = map.get(id);
    if (!row) map.set(id, (row = buckets.map(() => 0)));
    return row;
  };

  for (const split of splits) {
    const category = byId.get(split.categoryId);
    if (!category || !isCategoryKind(category.kind)) continue;
    if (category.kind === "transfer") continue;
    const cents = assertCents(split.amountCents);
    if (cents.isErr()) return err(cents.error);
    const month = Number(split.occurredOn.slice(0, 4)) * 12 + (Number(split.occurredOn.slice(5, 7)) - 1);
    const b = bucketOf(month);
    if (b < 0) continue;
    // outflows are negative cents: expense spending is positive, a refund (inflow) subtracts
    const signed = category.kind === "income" ? cents.value : -cents.value;
    slot(actual, category.id)[b] += signed;
  }
  for (const row of budgets) {
    const category = byId.get(row.categoryId);
    if (!category || category.kind !== "expense") continue;
    const amount = assertCents(row.amountCents);
    if (amount.isErr()) return err(amount.error);
    if (amount.value < 0) return err(new BudgetError("A budget cannot be negative."));
    const b = bucketOf(row.year * 12 + (row.month - 1));
    if (b < 0) continue;
    slot(budgetSum, category.id)[b] += amount.value;
    slot(budgetCount, category.id)[b] += 1;
  }

  type Line = PnlCategoryRow & { sortOrder: number; groupId: string | null; groupName: string | null; groupSort: number | null };
  const lines: Line[] = [];
  for (const category of own) {
    if (category.kind !== "income" && category.kind !== "expense") continue;
    const a = actual.get(category.id);
    const bs = budgetSum.get(category.id);
    const bc = budgetCount.get(category.id);
    // Only categories with money or a budget in the range show up.
    const active = (a?.some((v) => v !== 0) ?? false) || (bc?.some((v) => v > 0) ?? false);
    if (!active) continue;
    lines.push({
      id: category.id,
      name: category.name,
      kind: category.kind,
      sortOrder: category.sortOrder,
      groupId: category.groupId,
      groupName: category.groupName,
      groupSort: category.groupSort,
      periods: buckets.map((_, b) => {
        const actualCents = a?.[b] ?? 0;
        const budgetedMonths = bc?.[b] ?? 0;
        const budgetCents = category.kind === "expense" && budgetedMonths > 0 ? (bs?.[b] ?? 0) : null;
        return { actualCents, budgetCents, deltaCents: budgetCents === null ? null : actualCents - budgetCents, budgetedMonths, status: profitLossStatus(actualCents, budgetCents) };
      }),
    });
  }

  const sections = new Map<string, { id: string; name: string; groupSort: number; categories: Line[] }>();
  for (const line of lines) {
    const id = line.groupId ?? UNGROUPED_SECTION_ID;
    const section = sections.get(id) ?? {
      id,
      name: line.groupId ? (line.groupName?.trim() || "Group") : UNGROUPED_SECTION_NAME,
      groupSort: line.groupId ? (line.groupSort ?? 0) : Number.MAX_SAFE_INTEGER,
      categories: [],
    };
    section.categories.push(line);
    sections.set(id, section);
  }
  const groups: PnlGroup[] = [...sections.values()]
    .sort((x, y) => x.groupSort - y.groupSort || x.name.localeCompare(y.name) || x.id.localeCompare(y.id))
    .map((section) => ({
      id: section.id,
      name: section.name,
      categories: section.categories
        .sort((x, y) => {
          // income before expense inside a group, then the household's own order
          if (x.kind !== y.kind) return x.kind === "income" ? -1 : 1;
          return compareCatalogOrder({ id: x.id, name: x.name, sortOrder: x.sortOrder }, { id: y.id, name: y.name, sortOrder: y.sortOrder });
        })
        .map(({ id, name, kind, periods }) => ({ id, name, kind, periods })),
    }));

  const totals: PnlTotals[] = buckets.map((_, b) => {
    let incomeCents = 0;
    let expensesCents = 0;
    let budgetExpensesCents = 0;
    let budgeted = false;
    let budgetedActualCents = 0;
    for (const line of lines) {
      const cell = line.periods[b];
      if (line.kind === "income") incomeCents += cell.actualCents;
      else {
        expensesCents += cell.actualCents;
        if (cell.budgetCents !== null) {
          budgeted = true;
          budgetExpensesCents += cell.budgetCents;
          budgetedActualCents += cell.actualCents;
        }
      }
    }
    return { incomeCents, expensesCents, netCents: incomeCents - expensesCents, budgetExpensesCents: budgeted ? budgetExpensesCents : null, budgetedActualCents };
  });
  const periods: PnlPeriod[] = buckets.map((bucket) => ({
    key: bucket.key,
    label: bucket.label,
    from: formatBudgetMonth(fromIndex(bucket.first)),
    to: formatBudgetMonth(fromIndex(bucket.last)),
    months: bucket.last - bucket.first + 1,
    partial: bucket.last === index({ year: input.asOf.year, month: input.asOf.month }),
  }));

  return ok({ granularity: input.granularity, from: formatBudgetMonth(firstMonth), to: formatBudgetMonth(lastMonth), periods, groups, totals });
}
