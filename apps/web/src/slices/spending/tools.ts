import {
  FILTER_SOURCES,
  MEMBER_ROLES,
  RANGE_PRESETS,
  RECURRING_CHOICES,
  SAVED_FILTER_NAME_MAX,
  SEARCH_MAX_LENGTH,
  defineSpendingFilter,
  emptySpendingFilter,
  toIsoDate,
  type SpendingFilter,
} from "@dollas/domain";
import { confirmInput } from "@dollas/mcp";
import { z } from "zod";
import type { BooksContext } from "@/slices/access/member";
import { answer, isoDateInput, money, plural, tool, uuidInput } from "@/slices/agents/tool-kit";
import type { ServiceResult } from "@/lib/service-result";
import {
  createSavedFilter,
  deleteSavedFilter,
  getSavedFilter,
  getSpendingBreakdown,
  listSavedFilters,
  renameSavedFilter,
  type SavedFilterSummary,
  type SpendingDashboard,
} from "./service";

/**
 * The shared spending filter (PEN-212) as tool arguments, in snake_case. The
 * same model drives Activity, the Spending dashboard, and saved filters.
 */
export const FILTER_HELP =
  "Filter: range (all, this_month, last_month, last_90_days, this_year, last_year, or custom with from/to; dates in the household's time zone), account_ids, category_ids (\"uncategorized\" for the Uncategorized categories), group_ids (a transaction matches if any category line is in one of the categories or groups), member_ids (user ids from list_household, or \"unknown\" for rows from before attribution) with member_role (any, added = entered/imported/synced it, categorized = last set its categories), sources (manual, csv, bank; a CSV row a sync matched is both csv and bank), recurring (any, linked, not_linked), min_cents/max_cents (the transaction's size, either direction, inclusive), and search (payee or note text). saved_filter_id starts from a saved filter; other arguments override its fields.";

export const filterInput = {
  saved_filter_id: uuidInput("Saved filter to start from").optional(),
  range: z.enum(RANGE_PRESETS).optional().describe("Date range preset; custom uses from and to."),
  from: isoDateInput("First day (custom range)").optional(),
  to: isoDateInput("Last day (custom range)").optional(),
  account_ids: z.array(uuidInput("Account")).max(50).optional(),
  category_ids: z.array(z.union([z.literal("uncategorized"), uuidInput("Category")])).max(200).optional(),
  group_ids: z.array(uuidInput("Category group")).max(100).optional(),
  member_ids: z.array(z.string().min(1).max(64)).max(20).optional().describe('Household member user ids, or "unknown".'),
  member_role: z.enum(MEMBER_ROLES).optional(),
  sources: z.array(z.enum(FILTER_SOURCES)).max(3).optional(),
  recurring: z.enum(RECURRING_CHOICES).optional(),
  min_cents: z.number().int().min(0).optional().describe("Smallest transaction size in cents (absolute amount)."),
  max_cents: z.number().int().min(0).optional().describe("Largest transaction size in cents (absolute amount)."),
  search: z.string().max(SEARCH_MAX_LENGTH).optional().describe("Text in the payee or note, any case."),
};

export type FilterArgs = { [K in keyof typeof filterInput]?: z.infer<(typeof filterInput)[K]> };

/** Tool arguments → a validated SpendingFilter, starting from a saved filter when one is named. */
export async function filterFromArgs(books: BooksContext, args: FilterArgs, base: SpendingFilter = emptySpendingFilter()): Promise<ServiceResult<SpendingFilter>> {
  let start = base;
  if (args.saved_filter_id) {
    const saved = await getSavedFilter(books, args.saved_filter_id);
    if (!saved.ok) return saved;
    start = saved.value.filter;
  }
  const custom = args.from !== undefined || args.to !== undefined;
  const range = args.range ?? (custom ? "custom" : start.range);
  const defined = defineSpendingFilter({
    range,
    from: range === "custom" ? (args.from ?? (args.range ? null : start.from)) : null,
    to: range === "custom" ? (args.to ?? (args.range ? null : start.to)) : null,
    accountIds: args.account_ids ?? start.accountIds,
    categoryIds: args.category_ids ?? start.categoryIds,
    groupIds: args.group_ids ?? start.groupIds,
    memberIds: args.member_ids ?? start.memberIds,
    memberRole: args.member_role ?? start.memberRole,
    sources: args.sources ?? start.sources,
    recurring: args.recurring ?? start.recurring,
    minCents: args.min_cents ?? start.minCents,
    maxCents: args.max_cents ?? start.maxCents,
    search: args.search ?? start.search,
  });
  if (defined.isErr()) return { ok: false, error: defined.error, memberMessage: defined.error.message };
  return { ok: true, value: defined.value };
}

/** A filter as tool output (snake_case), the same shape the tools accept. */
export function shownFilter(filter: SpendingFilter) {
  return {
    range: filter.range,
    from: filter.from,
    to: filter.to,
    account_ids: filter.accountIds,
    category_ids: filter.categoryIds,
    group_ids: filter.groupIds,
    member_ids: filter.memberIds,
    member_role: filter.memberRole,
    sources: filter.sources,
    recurring: filter.recurring,
    min_cents: filter.minCents,
    max_cents: filter.maxCents,
    search: filter.search,
  };
}

function shownSaved(row: SavedFilterSummary) {
  return { id: row.id, name: row.name, created_by: row.createdBy, created_at: row.createdAt, filter: shownFilter(row.filter) };
}

const slice = (row: { key: string | null; name: string; spentCents: number; incomeCents: number; transactionCount: number }) => ({
  id: row.key,
  name: row.name,
  spent_cents: row.spentCents,
  income_cents: row.incomeCents,
  transaction_count: row.transactionCount,
});

function shownBoard(board: SpendingDashboard) {
  return {
    kind: "spending_breakdown",
    filter: shownFilter(board.filter),
    from: board.from,
    to: board.to,
    totals: {
      spent_cents: board.totals.spentCents,
      income_cents: board.totals.incomeCents,
      net_cents: board.totals.netCents,
      transaction_count: board.totals.transactionCount,
    },
    by_category: board.byCategory.map((row) => ({ ...slice(row), group_name: row.groupName })),
    by_group: board.byGroup.map(slice),
    by_account: board.byAccount.map(slice),
    member_role: board.memberRole,
    by_member: board.byMember.map(slice),
    trend: {
      unit: board.trend.unit,
      from: board.trend.from,
      to: board.trend.to,
      truncated: board.trend.truncated,
      buckets: board.trend.buckets.map((bucket) => ({
        from: bucket.from,
        to: bucket.to,
        label: bucket.label,
        spent_cents: bucket.spentCents,
        partial: bucket.partial,
        change: bucket.change == null ? null : bucket.change.comparable ? { delta_cents: bucket.change.deltaCents, direction: bucket.change.direction } : { comparable: false, label: bucket.change.label },
      })),
    },
  };
}

const filterObject = z
  .object({
    range: filterInput.range,
    from: filterInput.from,
    to: filterInput.to,
    account_ids: filterInput.account_ids,
    category_ids: filterInput.category_ids,
    group_ids: filterInput.group_ids,
    member_ids: filterInput.member_ids,
    member_role: filterInput.member_role,
    sources: filterInput.sources,
    recurring: filterInput.recurring,
    min_cents: filterInput.min_cents,
    max_cents: filterInput.max_cents,
    search: filterInput.search,
  })
  .describe("The filter to save, in the same shape list_transactions and get_spending_breakdown take.");

export const spendingTools = [
  tool({
    name: "get_spending_breakdown",
    title: "Get spending breakdown",
    description: `The Spending dashboard on History: totals (spent, income, net, transaction count), spending by category, group, account, and member, and a trend (weeks for ranges up to 62 days, months beyond; the bucket holding today is partial and not comparable yet). Spending and income count as Home does: expense categories are spending, income categories are income, transfers neither. A category or group filter counts only the matching category lines of a split transaction. by_member follows member_role (categorized: who categorized; otherwise who added). Defaults to this_month. ${FILTER_HELP} Integer cents.`,
    access: "read",
    input: filterInput,
    async run(args, { books }) {
      const filter = await filterFromArgs(books, args, emptySpendingFilter("this_month"));
      if (!filter.ok) return answer(filter, () => "");
      return answer(
        await getSpendingBreakdown(books, filter.value, toIsoDate(books.asOf)),
        (board) =>
          `Spent ${money(board.totals.spentCents, books)} and took in ${money(board.totals.incomeCents, books)} across ${plural(board.totals.transactionCount, "transaction")}${board.byCategory[0] && board.byCategory[0].spentCents > 0 ? `; most on ${board.byCategory[0].name} (${money(board.byCategory[0].spentCents, books)})` : ""}.`,
        shownBoard,
      );
    },
  }),
  tool({
    name: "list_saved_filters",
    title: "List saved filters",
    description: "The household's saved spending filters, shared by every member. Pass one's id as saved_filter_id to list_transactions or get_spending_breakdown.",
    access: "read",
    input: {},
    async run(_args, { books }) {
      return answer(
        await listSavedFilters(books),
        (rows) => `${plural(rows.length, "saved filter")}.`,
        (rows) => ({ items: rows.map(shownSaved) }),
      );
    },
  }),
  tool({
    name: "create_saved_filter",
    title: "Save a filter",
    description: `Save a spending filter for the whole household under a name (1-${SAVED_FILTER_NAME_MAX} characters, unique in the household, any case). Date presets stay relative: this_month always means the current month.`,
    access: "write",
    input: { name: z.string().min(1).max(SAVED_FILTER_NAME_MAX), filter: filterObject },
    async run(args, { books }) {
      const filter = await filterFromArgs(books, args.filter);
      if (!filter.ok) return answer(filter, () => "");
      return answer(await createSavedFilter(books, { name: args.name, filter: filter.value }, "mcp"), (row) => `Saved “${row.name}”.`, shownSaved);
    },
  }),
  tool({
    name: "rename_saved_filter",
    title: "Rename a saved filter",
    description: "Rename one of the household's saved filters. Names are unique in the household, any case.",
    access: "write",
    idempotent: true,
    input: { saved_filter_id: uuidInput("Saved filter"), name: z.string().min(1).max(SAVED_FILTER_NAME_MAX) },
    async run(args, { books }) {
      return answer(await renameSavedFilter(books, args.saved_filter_id, args.name, "mcp"), (row) => `Renamed to “${row.name}”.`);
    },
  }),
  tool({
    name: "delete_saved_filter",
    title: "Delete a saved filter",
    description: "Delete one of the household's saved filters, for every member. Transactions are not touched.",
    access: "write",
    destructive: true,
    input: { saved_filter_id: uuidInput("Saved filter"), confirm: confirmInput("delete this saved filter for the whole household") },
    async run(args, { books }) {
      return answer(await deleteSavedFilter(books, args.saved_filter_id, "mcp"), (row) => `Deleted “${row.name}”.`);
    },
  }),
];
