import { CADENCES, toIsoDate, type RecurringOccurrence } from "@dollas/domain";
import { confirmInput, pageInput, paginate, readPage } from "@dollas/mcp";
import { z } from "zod";
import { answer, centsInput, isoDateInput, money, plural, tool, uuidInput } from "@/slices/agents/tool-kit";
import {
  createRecurringItem,
  deleteRecurringItem,
  getRecurringItem,
  linkRecurringTransaction,
  listRecurringItems,
  setRecurringItemPaused,
  suggestRecurring,
  unlinkRecurringTransaction,
  updateRecurringItem,
  type RecurringItemSummary,
} from "./service";

const MATCHING =
  "A transaction links to an item when its payee contains the item's payee_match (case-insensitive), the amount has the same sign and is within tolerance (the larger of tolerance_percent of the amount and tolerance_cents), and its date is within window_days of an expected date. One transaction per occurrence; soft-deleted transactions never count; a pair a member unlinked is never relinked.";
const STATUSES = "Occurrence status: paid (bill) or received (income) when a transaction is linked, expected when due within the window, missed when the window passed with nothing linked, upcoming otherwise.";

function occurrence(row: RecurringOccurrence) {
  return {
    date: row.date,
    expected_cents: row.expectedCents,
    status: row.status,
    transaction: row.transaction
      ? { id: row.transaction.id, occurred_on: row.transaction.occurredOn, payee: row.transaction.payee, amount_cents: row.transaction.amountCents }
      : null,
  };
}

function summary(item: RecurringItemSummary) {
  return {
    id: item.id,
    name: item.name,
    payee_match: item.payeeMatch,
    amount_cents: item.amountCents,
    kind: item.kind,
    cadence: item.cadence,
    anchor_date: item.anchorDate,
    day_of_month: item.dayOfMonth,
    second_day_of_month: item.secondDayOfMonth,
    category_id: item.categoryId,
    category_name: item.categoryName,
    account_id: item.accountId,
    account_name: item.accountName,
    tolerance_percent: item.tolerancePercent,
    tolerance_cents: item.toleranceCents,
    window_days: item.windowDays,
    start_date: item.startDate,
    end_date: item.endDate,
    paused: item.paused,
    next_date: item.nextDate,
    month_status: item.monthStatus,
    this_month: item.thisMonth.map(occurrence),
  };
}

const fields = {
  name: z.string().min(1).max(80).describe("What to call it, e.g. Rent or Paycheck."),
  payee_match: z.string().min(2).max(200).optional().describe("Text a matching transaction's payee contains, case-insensitive. Defaults to the name."),
  amount_cents: centsInput("Expected amount, signed: negative for a bill, positive for income,"),
  cadence: z.enum(CADENCES).describe("weekly, biweekly (every 2 weeks), semimonthly (twice a month), monthly, quarterly, or yearly."),
  anchor_date: isoDateInput("The date of one occurrence; the schedule repeats from it"),
  day_of_month: z.number().int().min(1).max(31).optional().describe("Month-based cadences: the intended day, e.g. 31 (clamped to short months). Defaults to the anchor's day."),
  second_day_of_month: z.number().int().min(1).max(31).optional().describe("Twice a month only (required there): the second day."),
  category_id: uuidInput("Category (optional)").optional(),
  account_id: uuidInput("Account (optional; when set, only that account's transactions match)").optional(),
  tolerance_percent: z.number().int().min(0).max(50).optional().describe("Amount tolerance in percent. Default 5."),
  tolerance_cents: z.number().int().min(0).max(10_000_000).optional().describe("Fixed amount tolerance in cents; the larger of the two applies. Default 0."),
  window_days: z.number().int().min(0).max(10).optional().describe("Days either side of the expected date. Default 3."),
  start_date: isoDateInput("First day it applies (default: anchor_date)").optional(),
  end_date: isoDateInput("Last day it applies (optional)").optional(),
};

type Fields = { [K in keyof typeof fields]?: z.infer<(typeof fields)[K]> | null };

function toInput(args: Fields) {
  return {
    name: args.name,
    payeeMatch: args.payee_match,
    amountCents: args.amount_cents,
    cadence: args.cadence,
    anchorDate: args.anchor_date,
    dayOfMonth: args.day_of_month,
    secondDayOfMonth: args.second_day_of_month,
    categoryId: args.category_id,
    accountId: args.account_id,
    tolerancePercent: args.tolerance_percent,
    toleranceCents: args.tolerance_cents,
    windowDays: args.window_days,
    startDate: args.start_date,
    endDate: args.end_date,
  };
}

export const recurringTools = [
  tool({
    name: "list_recurring_items",
    title: "List recurring items",
    description: `Known bills and paychecks with their schedule, next expected date, and this month's occurrences. ${STATUSES} month_status is the most urgent of this month's statuses ("none" when nothing falls this month, "paused" for a paused item).`,
    access: "read",
    input: { ...pageInput(100) },
    async run(args, { books }) {
      return answer(
        await listRecurringItems(books, toIsoDate(books.asOf)),
        (items) => `${plural(items.length, "recurring item")}.`,
        (items) => paginate(items.map(summary), readPage(args, 100)),
      );
    },
  }),
  tool({
    name: "get_recurring_item",
    title: "Get recurring item",
    description: `One recurring item with its occurrences from three months back to the next few, each with a status and linked transaction, and its linked history. ${STATUSES}`,
    access: "read",
    input: { item_id: uuidInput("Recurring item") },
    async run(args, { books }) {
      return answer(
        await getRecurringItem(books, args.item_id, toIsoDate(books.asOf)),
        (item) => `${item.name}: ${money(item.amountCents, books)} ${item.cadenceLabel.toLowerCase()}, next ${item.nextDate ?? "none"}.`,
        (item) => ({
          ...summary(item),
          occurrences: item.occurrences.map(occurrence),
          history: item.history.map((row) => ({
            transaction_id: row.transactionId,
            occurrence_date: row.occurrenceDate,
            occurred_on: row.occurredOn,
            payee: row.payee,
            amount_cents: row.amountCents,
            linked_by: row.source === "manual" ? "member" : "matching",
          })),
        }),
      );
    },
  }),
  tool({
    name: "create_recurring_item",
    title: "Create recurring item",
    description: `Add a known bill or paycheck. Matching transactions from the last 180 days are linked right away, and new ones as they are added, imported, or synced. ${MATCHING}`,
    access: "write",
    input: fields,
    async run(args, { books }) {
      return answer(
        await createRecurringItem(
          books,
          { ...toInput(args), name: args.name, amountCents: args.amount_cents, cadence: args.cadence, anchorDate: args.anchor_date },
          toIsoDate(books.asOf),
          "mcp",
        ),
        (value) => `Added ${value.name}; linked ${plural(value.linked, "transaction")}.`,
      );
    },
  }),
  tool({
    name: "update_recurring_item",
    title: "Update recurring item",
    description: "Change any fields of a recurring item; fields left out stay as they are. Links already made stay; new matches are linked.",
    access: "write",
    idempotent: true,
    input: {
      item_id: uuidInput("Recurring item"),
      ...fields,
      name: fields.name.optional(),
      amount_cents: fields.amount_cents.optional(),
      cadence: fields.cadence.optional(),
      anchor_date: fields.anchor_date.optional(),
      day_of_month: fields.day_of_month.unwrap().nullable().optional().describe("Month day, or null to use the anchor's day."),
      category_id: uuidInput("Category").nullable().optional().describe("Category id, or null to clear."),
      account_id: uuidInput("Account").nullable().optional().describe("Account id, or null to match any account."),
      end_date: isoDateInput("Last day it applies").nullable().optional().describe("ISO date, or null for no end."),
    },
    async run(args, { books }) {
      const patch = Object.fromEntries(Object.entries(toInput(args)).filter(([, value]) => value !== undefined));
      return answer(
        await updateRecurringItem(books, args.item_id, patch, toIsoDate(books.asOf), "mcp"),
        (value) => `Saved ${value.name}; linked ${plural(value.linked, "more transaction")}.`,
      );
    },
  }),
  tool({
    name: "pause_recurring_item",
    title: "Pause recurring item",
    description: "Stop expecting and matching a recurring item. Its linked history stays.",
    access: "write",
    idempotent: true,
    input: { item_id: uuidInput("Recurring item") },
    async run(args, { books }) {
      return answer(await setRecurringItemPaused(books, args.item_id, true, toIsoDate(books.asOf), "mcp"), (value) => `Paused ${value.name}.`);
    },
  }),
  tool({
    name: "resume_recurring_item",
    title: "Resume recurring item",
    description: "Expect and match a paused recurring item again; matching transactions from the last 180 days are linked.",
    access: "write",
    idempotent: true,
    input: { item_id: uuidInput("Recurring item") },
    async run(args, { books }) {
      return answer(
        await setRecurringItemPaused(books, args.item_id, false, toIsoDate(books.asOf), "mcp"),
        (value) => `Resumed ${value.name}; linked ${plural(value.linked, "transaction")}.`,
      );
    },
  }),
  tool({
    name: "delete_recurring_item",
    title: "Delete recurring item",
    description: "Delete a recurring item. Its linked transactions stay, standing alone again.",
    access: "write",
    destructive: true,
    input: { item_id: uuidInput("Recurring item"), confirm: confirmInput("delete this recurring item") },
    async run(args, { books }) {
      return answer(
        await deleteRecurringItem(books, args.item_id, "mcp"),
        (value) => `Deleted ${value.name}; ${plural(value.unlinked, "transaction")} now stand alone.`,
      );
    },
  }),
  tool({
    name: "link_recurring_transaction",
    title: "Link transaction to recurring item",
    description:
      "Link a transaction to a recurring item by hand (payee and amount are not checked). It takes the item's nearest open occurrence and leaves any other item. Undoes an earlier unlink of this pair.",
    access: "write",
    idempotent: true,
    input: { item_id: uuidInput("Recurring item"), transaction_id: uuidInput("Transaction") },
    async run(args, { books }) {
      return answer(
        await linkRecurringTransaction(books, args.item_id, args.transaction_id, "mcp"),
        (value) => `Linked to ${value.name} for ${value.occurrenceDate}.`,
      );
    },
  }),
  tool({
    name: "unlink_recurring_transaction",
    title: "Unlink transaction from recurring item",
    description: "Unlink a transaction from its recurring item. It stands alone, and matching will not link this pair again.",
    access: "write",
    idempotent: true,
    input: { transaction_id: uuidInput("Transaction") },
    async run(args, { books }) {
      return answer(await unlinkRecurringTransaction(books, args.transaction_id, "mcp"), (value) => `Unlinked from ${value.name}.`);
    },
  }),
  tool({
    name: "suggest_recurring_items",
    title: "Suggest recurring items",
    description:
      "Payees in the last 200 days that look like a weekly, every-2-weeks, twice-a-month, or monthly bill or paycheck and have no item yet: at least three charges, steady gaps, amounts within 10%. Pass a suggestion's fields to create_recurring_item to make it recurring.",
    access: "read",
    input: {},
    async run(_args, { books }) {
      return answer(await suggestRecurring(books, toIsoDate(books.asOf)), (items) => `${plural(items.length, "suggestion")}.`, (items) => ({ items }));
    },
  }),
];
