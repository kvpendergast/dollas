import { MAX_TRANSACTION_SPLITS, PAYEE_MAX_LENGTH } from "@dollas/domain";
import { confirmInput, pageFrom, pageInput, readPage } from "@dollas/mcp";
import { z } from "zod";
import { answer, centsInput, isoDateInput, money, plural, tool, uuidInput } from "@/slices/agents/tool-kit";
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
    splits: item.splits.map((split) => ({ category_id: split.categoryId, category_name: split.categoryName, amount_cents: split.amountCents })),
  };
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
    description: `Transactions in the household books, newest first, with their category splits. ${SIGN} bank_backed means the bank reported the charge; bank_matched means sync matched it to a CSV or manual entry (see separate_bank_match). Filter by account, category, date range, or payee text.`,
    access: "read",
    input: {
      account_id: uuidInput("Account").optional(),
      category_id: uuidInput("Category").optional(),
      from: isoDateInput("First day to include").optional(),
      to: isoDateInput("Last day to include").optional(),
      payee_contains: z.string().min(1).max(PAYEE_MAX_LENGTH).optional().describe("Only payees containing this text (case-insensitive)."),
      deleted_only: z.boolean().optional().describe("List deleted transactions instead, so one can be restored."),
      ...pageInput(50),
    },
    async run(args, { books }) {
      const request = readPage(args, 50);
      const listed = await listHouseholdTransactions(books, {
        ...request,
        accountId: args.account_id,
        categoryId: args.category_id,
        from: args.from,
        to: args.to,
        payeeContains: args.payee_contains,
        deletedOnly: args.deleted_only,
      });
      return answer(
        listed,
        (page) => `${plural(page.items.length, "transaction")} of ${page.total}.`,
        (page) => pageFrom(page.items.map(shown), page.total, request),
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
    description: "Delete a transaction. It leaves the books and totals; restore_transaction can bring it back, and a re-import will not add it again.",
    access: "write",
    destructive: true,
    input: { transaction_id: uuidInput("Transaction"), confirm: confirmInput("delete this transaction from the books") },
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
