import { MAX_TRANSACTION_SPLITS, PAYEE_MAX_LENGTH, toIsoDate } from "@dollas/domain";
import { confirmInput, pageFrom, pageInput, paginate, readPage } from "@dollas/mcp";
import { z } from "zod";
import { answer, centsInput, isoDateInput, money, plural, tool, uuidInput } from "@/slices/agents/tool-kit";
import { categorizeByPayee, categorizeTransactions, BULK_CATEGORIZE_MAX_IDS, type BulkCategorizeOutcome } from "./bulk-categorize-service";
import { listHouseholdPayees } from "./payees-service";
import { createHouseholdTransfer } from "./transfer-service";
import { FILTER_HELP, filterFromArgs, filterInput } from "@/slices/spending/tools";
import {
  amendHouseholdTransaction,
  createHouseholdTransaction,
  deleteHouseholdTransaction,
  listHouseholdTransactions,
  restoreHouseholdTransaction,
  separateBankMatch,
  type ListedTransaction,
  type SavedTransaction,
} from "./transactions";

const splitsInput = z
  .array(
    z.object({
      category_id: uuidInput("Category"),
      amount_cents: centsInput("This part, with the same sign as the transaction"),
    }),
  )
  .min(1)
  .max(MAX_TRANSACTION_SPLITS);

function shown(item: ListedTransaction) {
  return {
    id: item.id,
    occurred_on: item.occurredOn,
    payee: item.payee,
    amount_cents: item.amountCents,
    account_id: item.accountId,
    account_name: item.accountName,
    account_archived: item.accountArchived,
    deleted: item.deleted,
    bank_backed: item.bankBacked,
    bank_matched: item.bankMatched,
    recurring_item: item.recurring ? { id: item.recurring.id, name: item.recurring.name } : null,
    sources: item.sources,
    added_by: item.addedBy,
    categorized_by: item.categorizedBy,
    note: item.note,
    splits: item.splits.map((split) => ({ category_id: split.categoryId, category_name: split.categoryName, amount_cents: split.amountCents })),
  };
}

const COMPACT_FIELDS = ["id", "occurred_on", "payee", "amount_cents", "account_name", "category", "category_id"] as const;
const ALL_FIELDS = [
  "id", "occurred_on", "payee", "amount_cents", "account_id", "account_name", "account_archived", "deleted", "bank_backed",
  "bank_matched", "recurring_item", "sources", "added_by", "categorized_by", "note", "splits", "category", "category_id",
] as const;

/** A listed transaction with its fields trimmed to what the caller asked for (PEN-282). id is always kept. */
function projected(item: ListedTransaction, fields: readonly string[] | undefined, compact: boolean | undefined) {
  const wanted = fields && fields.length > 0 ? fields : compact ? COMPACT_FIELDS : null;
  if (!wanted) return shown(item);
  const first = item.splits[0];
  const extra: Record<string, unknown> = {
    category: item.splits.length === 0 ? null : item.splits.length === 1 ? first?.categoryName : `Split: ${item.splits.map((split) => split.categoryName).join(", ")}`,
    category_id: item.splits.length === 1 ? first?.categoryId : null,
  };
  const full: Record<string, unknown> = { ...shown(item), ...extra };
  return Object.fromEntries(["id", ...wanted.filter((field) => field !== "id")].map((field) => [field, full[field]]));
}

export function bulkOut(value: BulkCategorizeOutcome) {
  return {
    category_id: value.categoryId,
    category_name: value.categoryName,
    dry_run: value.dryRun,
    changed: value.changed,
    already_in_category: value.alreadyThere,
    skipped_split: value.skippedSplit,
    skipped_without_category: value.skippedWithoutCategory,
    not_found: value.notFound,
    sample_changed: value.samples.map((item) => ({ id: item.id, payee: item.payee, amount_cents: item.amountCents })),
  };
}

function bulkSummary(value: BulkCategorizeOutcome): string {
  const lead = value.dryRun ? `Would move ${plural(value.changed, "transaction")}` : `Moved ${plural(value.changed, "transaction")}`;
  const notes = [
    value.alreadyThere ? `${value.alreadyThere} already there` : "",
    value.skippedSplit ? `${plural(value.skippedSplit, "split transaction")} skipped` : "",
    value.notFound ? `${value.notFound} not found` : "",
  ].filter(Boolean);
  return `${lead} to ${value.categoryName}${notes.length ? ` (${notes.join(", ")})` : ""}.`;
}

function saved(value: SavedTransaction) {
  return {
    id: value.id,
    occurred_on: value.occurredOn,
    payee: value.payee,
    amount_cents: value.amountCents,
    account_id: value.accountId,
    splits: value.splits.map((split) => ({ category_id: split.categoryId, amount_cents: split.amountCents })),
  };
}

function splitsFrom(splits: Array<{ category_id: string; amount_cents: number }>) {
  return splits.map((split) => ({ categoryId: split.category_id, amountCents: split.amount_cents }));
}

const SIGN = "amount_cents is signed integer cents: negative is money out (spending), positive is money in.";

export const transactionTools = [
  tool({
    name: "list_transactions",
    title: "List transactions",
    description: `Transactions in the household, newest first, with their category splits. ${SIGN} bank_backed means the bank reported the charge; bank_matched means sync matched it to a CSV or manual entry (see separate_bank_match). recurring_item is the bill or paycheck it is linked to, if any. sources is manual, or csv and/or bank; added_by and categorized_by are the members who added it and last set its categories (null: Unknown, from before this was recorded). ${FILTER_HELP} account_id and category_id (one each) and payee_contains still work. Activity in the web app uses the same filter.`,
    access: "read",
    input: {
      ...filterInput,
      account_id: uuidInput("Account (same as account_ids with one id)").optional(),
      category_id: uuidInput("Category (same as category_ids with one id)").optional(),
      payee_contains: z.string().min(1).max(PAYEE_MAX_LENGTH).optional().describe("Only payees containing this text (case-insensitive)."),
      deleted_only: z.boolean().optional().describe("List deleted transactions instead, so one can be restored."),
      compact: z.boolean().optional().describe("Return only id, occurred_on, payee, amount_cents, account_name, category (a name, or Split: ...) and category_id. Much smaller."),
      fields: z.array(z.enum(ALL_FIELDS)).max(ALL_FIELDS.length).optional().describe("Return only these fields (id is always included). Overrides compact."),
      ...pageInput(50),
    },
    async run(args, { books }) {
      const request = readPage(args, 50);
      const filter = await filterFromArgs(books, {
        ...args,
        account_ids: args.account_ids ?? (args.account_id ? [args.account_id] : undefined),
        category_ids: args.category_ids ?? (args.category_id ? [args.category_id] : undefined),
      });
      if (!filter.ok) return answer(filter, () => "");
      const listed = await listHouseholdTransactions(books, {
        ...request,
        payeeContains: args.payee_contains,
        deletedOnly: args.deleted_only,
        spending: { filter: filter.value, today: toIsoDate(books.asOf) },
      });
      return answer(
        listed,
        (page) => `${plural(page.items.length, "transaction")} of ${page.total}.`,
        (page) => pageFrom(page.items.map((item) => projected(item, args.fields, args.compact)), page.total, request),
      );
    },
  }),
  tool({
    name: "list_payees",
    title: "List payees",
    description:
      "Payees across the household (ignoring case), each with transaction_count, total_cents (signed) and uncategorized_count (transactions still in the Uncategorized fallback), plus household-wide totals. Deleted transactions are left out. Use it to find what to categorize with categorize_by_payee or create_payee_rule. sort: transactions (default), total, uncategorized, name.",
    access: "read",
    input: {
      contains: z.string().min(1).max(PAYEE_MAX_LENGTH).optional().describe("Only payees containing this text (case-insensitive)."),
      uncategorized_only: z.boolean().optional().describe("Only payees with at least one uncategorized transaction."),
      sort: z.enum(["transactions", "total", "uncategorized", "name"]).optional(),
      ...pageInput(50),
    },
    async run(args, { books }) {
      const listed = await listHouseholdPayees(books, { contains: args.contains, uncategorizedOnly: args.uncategorized_only, sort: args.sort });
      return answer(
        listed,
        (value) => `${plural(value.payeeCount, "payee")}, ${value.uncategorizedTransactionCount} uncategorized ${value.uncategorizedTransactionCount === 1 ? "transaction" : "transactions"}.`,
        (value) => ({
          payee_count: value.payeeCount,
          transaction_count: value.transactionCount,
          total_cents: value.totalCents,
          uncategorized_transaction_count: value.uncategorizedTransactionCount,
          ...paginate(
            value.payees.map((item) => ({
              payee: item.payee,
              transaction_count: item.transactionCount,
              total_cents: item.totalCents,
              uncategorized_count: item.uncategorizedCount,
              top_categories: item.topCategories,
            })),
            readPage(args, 50),
          ),
        }),
      );
    },
  }),
  tool({
    name: "create_transaction",
    title: "Create transaction",
    description: `Add a transaction to an account. ${SIGN} Give one category_id for the whole amount, or splits that add up to amount_cents.`,
    access: "write",
    input: {
      account_id: uuidInput("Account"),
      occurred_on: isoDateInput("Date"),
      payee: z.string().min(1).max(PAYEE_MAX_LENGTH).describe("Who was paid or who paid."),
      amount_cents: centsInput("Signed amount"),
      category_id: uuidInput("Category for the whole amount").optional(),
      splits: splitsInput.optional().describe("Category splits; use instead of category_id. They must add up to amount_cents."),
    },
    async run(args, { books }) {
      if (Boolean(args.category_id) === Boolean(args.splits)) return { ok: false, message: "Give either category_id or splits." };
      const splits = args.splits ? splitsFrom(args.splits) : [{ categoryId: args.category_id ?? "", amountCents: args.amount_cents }];
      const created = await createHouseholdTransaction(
        books,
        { accountId: args.account_id, occurredOn: args.occurred_on, payee: args.payee, amountCents: args.amount_cents, splits },
        "mcp",
      );
      return answer(created, (value) => `Added ${value.payee} for ${money(value.amountCents, books)} on ${value.occurredOn}.`, saved);
    },
  }),
  tool({
    name: "create_transfer",
    title: "Create transfer",
    description:
      "Move money between two of the household's own accounts, e.g. a credit card payment from checking. Writes two transactions (money out of from_account_id, money into to_account_id) in the Transfers category, which is made on first use. Transfers are neither income nor spending. Use this for the rows commit_csv_import flags as possible_transfer instead of importing both sides as spending. amount_cents is a positive amount.",
    access: "write",
    input: {
      from_account_id: uuidInput("Account the money leaves"),
      to_account_id: uuidInput("Account the money goes into"),
      amount_cents: centsInput("Positive amount"),
      occurred_on: isoDateInput("Date"),
    },
    async run(args, { books }) {
      const created = await createHouseholdTransfer(
        books,
        { fromAccountId: args.from_account_id, toAccountId: args.to_account_id, amountCents: args.amount_cents, occurredOn: args.occurred_on },
        "mcp",
      );
      return answer(
        created,
        (value) => `Moved ${money(value.amountCents, books)} from ${value.fromAccountName} to ${value.toAccountName} on ${value.occurredOn}.`,
        (value) => ({
          from_transaction_id: value.fromTransactionId,
          to_transaction_id: value.toTransactionId,
          category_id: value.categoryId,
          amount_cents: value.amountCents,
          occurred_on: value.occurredOn,
        }),
      );
    },
  }),
  tool({
    name: "update_transaction",
    title: "Update transaction",
    description: `Edit a transaction. Only the fields you give change. ${SIGN} Changing the amount of a split transaction needs the splits again.`,
    access: "write",
    idempotent: true,
    input: {
      transaction_id: uuidInput("Transaction"),
      account_id: uuidInput("Account").optional(),
      occurred_on: isoDateInput("Date").optional(),
      payee: z.string().min(1).max(PAYEE_MAX_LENGTH).optional(),
      amount_cents: centsInput("Signed amount").optional(),
      splits: splitsInput.optional().describe("Replace the category splits. They must add up to the amount."),
    },
    async run(args, { books }) {
      const edited = await amendHouseholdTransaction(
        books,
        args.transaction_id,
        {
          accountId: args.account_id,
          occurredOn: args.occurred_on,
          payee: args.payee,
          amountCents: args.amount_cents,
          splits: args.splits ? splitsFrom(args.splits) : undefined,
        },
        "mcp",
      );
      return answer(edited, (value) => `Saved ${value.payee}.`, saved);
    },
  }),
  tool({
    name: "categorize_transaction",
    title: "Categorize transaction",
    description: "Put the whole transaction in one category, replacing any splits. Payee rules are not changed.",
    access: "write",
    idempotent: true,
    input: { transaction_id: uuidInput("Transaction"), category_id: uuidInput("Category") },
    async run(args, { books }) {
      const edited = await amendHouseholdTransaction(books, args.transaction_id, { categoryId: args.category_id }, "mcp");
      return answer(edited, (value) => `Categorized ${value.payee}.`, saved);
    },
  }),
  tool({
    name: "categorize_transactions",
    title: "Categorize transactions in bulk",
    description: `Put up to ${BULK_CATEGORIZE_MAX_IDS} transactions in one category in one step. Split transactions are skipped (use split_transaction), as are deleted or unknown ids; the counts say how many. dry_run reports what would change without writing. Payee rules are not changed.`,
    access: "write",
    idempotent: true,
    input: {
      transaction_ids: z.array(uuidInput("Transaction")).min(1).max(BULK_CATEGORIZE_MAX_IDS),
      category_id: uuidInput("Category"),
      dry_run: z.boolean().optional().describe("Report the counts and a sample without changing anything."),
    },
    async run(args, { books }) {
      return answer(
        await categorizeTransactions(books, { transactionIds: args.transaction_ids, categoryId: args.category_id, dryRun: args.dry_run }, "mcp"),
        bulkSummary,
        bulkOut,
      );
    },
  }),
  tool({
    name: "categorize_by_payee",
    title: "Categorize all transactions from a payee",
    description:
      "Put every existing transaction from a payee in one category without making a payee rule (use create_payee_rule with apply_to_existing to also cover future imports). match exact (default) compares the whole payee, ignoring case; contains matches payees that include the text. Split transactions are skipped. dry_run reports the counts without writing.",
    access: "write",
    idempotent: true,
    input: {
      payee: z.string().min(1).max(200).describe("The payee text."),
      match: z.enum(["exact", "contains"]).optional(),
      category_id: uuidInput("Category"),
      dry_run: z.boolean().optional().describe("Report the counts and a sample without changing anything."),
    },
    async run(args, { books }) {
      return answer(
        await categorizeByPayee(books, { payee: args.payee, match: args.match ?? "exact", categoryId: args.category_id, dryRun: args.dry_run }, "mcp"),
        bulkSummary,
        bulkOut,
      );
    },
  }),
  tool({
    name: "split_transaction",
    title: "Split transaction",
    description: `Divide a transaction across categories. The splits replace the current categories and must add up to the transaction's amount_cents, with the same sign.`,
    access: "write",
    idempotent: true,
    input: { transaction_id: uuidInput("Transaction"), splits: splitsInput.min(2).describe("Two or more category splits.") },
    async run(args, { books }) {
      const edited = await amendHouseholdTransaction(books, args.transaction_id, { splits: splitsFrom(args.splits) }, "mcp");
      return answer(edited, (value) => `Split ${value.payee} across ${plural(value.splits.length, "category", "categories")}.`, saved);
    },
  }),
  tool({
    name: "delete_transaction",
    title: "Delete transaction",
    description: "Delete a transaction. It leaves the totals; restore_transaction can bring it back, and a re-import will not add it again.",
    access: "write",
    destructive: true,
    input: { transaction_id: uuidInput("Transaction"), confirm: confirmInput("delete this transaction") },
    async run(args, { books }) {
      return answer(await deleteHouseholdTransaction(books, args.transaction_id, "mcp"), (value) => `Deleted ${value.payee}.`);
    },
  }),
  tool({
    name: "restore_transaction",
    title: "Restore transaction",
    description: "Bring back a deleted transaction (find it with list_transactions and deleted_only).",
    access: "write",
    idempotent: true,
    input: { transaction_id: uuidInput("Transaction") },
    async run(args, { books }) {
      return answer(await restoreHouseholdTransaction(books, args.transaction_id, "mcp"), (value) => `Restored ${value.payee}.`);
    },
  }),
  tool({
    name: "separate_bank_match",
    title: "Not the same charge",
    description:
      "Split a transaction that bank sync matched to a CSV or manual entry (bank_matched: true in list_transactions) when they are really two charges. Your entry keeps its edits; the bank's charge becomes its own transaction with the bank's date and payee, and sync will not match them again.",
    access: "write",
    input: { transaction_id: uuidInput("Matched transaction") },
    async run(args, { books }) {
      return answer(
        await separateBankMatch(books, args.transaction_id, "mcp"),
        (value) => `Separated. ${value.payee} is now its own transaction.`,
      );
    },
  }),
];
