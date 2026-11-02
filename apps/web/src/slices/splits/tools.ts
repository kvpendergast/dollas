import { MAX_SPLIT_LINES, NOTE_MAX_LENGTH, PAYEE_MAX_LENGTH } from "@dollas/domain";
import { confirmInput, pageFrom, pageInput, readPage } from "@dollas/mcp";
import { z } from "zod";
import type { ServiceResult } from "@/lib/service-result";
import { answer, isoDateInput, plural, tool, uuidInput } from "@/slices/agents/tool-kit";
import {
  createSplit,
  createSplits,
  getSplit,
  listSplits,
  MAX_BULK_SPLITS,
  splitDifferenceOf,
  unsplitTransaction,
  updateSplit,
  type SplitLineInput,
} from "./service";
import { linkTransfer, suggestTransferLinks, unlinkTransfer } from "./pairs";
import type { SplitView } from "./store";

const KIND_HELP =
  "A paycheck (positive, income-category parent) is an income split: the parent stays gross income and the lines are negative taxes (expense categories) and 401(k) / net pay (transfer categories); a net-pay line can set to_account_id to put the same amount into a bank account, or deposit_transaction_id to link the deposit the bank already has there (see suggest_transfer_links), so net pay counts once. Any other parent (a Costco run, a Venmo payment) is an allocation split: the parent leaves every total and the lines count instead. Different from split_transaction, which only divides one transaction across categories.";

const lineInput = z.object({
  category_id: uuidInput("Category"),
  amount_cents: z.number().int().safe().positive().optional().describe("This line as a positive number of cents; the sign follows the split. Give this or remainder_percent."),
  remainder_percent: z.number().positive().max(100).optional().describe("Share of what the fixed lines leave, 0-100; percent lines must add up to 100."),
  payee: z.string().max(PAYEE_MAX_LENGTH).optional().describe("Defaults to the parent's payee."),
  to_account_id: uuidInput("Deposit account").optional().describe("Income splits only, on a transfer line: also add this amount to that account (net pay into checking)."),
  deposit_transaction_id: uuidInput("Existing deposit")
    .optional()
    .describe(
      "Income splits only, on a transfer line, instead of to_account_id: link the deposit already in another account (from bank sync or a CSV) for the same amount. It takes the line's transfer category, so it stops counting as income. On update_split, leaving it out of a line unlinks that line.",
    ),
  reimbursed: z.boolean().optional().describe("Allocation splits on a charge only: someone pays this part back, so it stays on the account but leaves spending."),
  note: z.string().max(NOTE_MAX_LENGTH).optional(),
});

const linesInput = z.array(lineInput).min(1).max(MAX_SPLIT_LINES);

type LineArgs = z.infer<typeof lineInput>;

function linesFrom(lines: readonly LineArgs[]): SplitLineInput[] {
  return lines.map((line) => ({
    categoryId: line.category_id,
    amountCents: line.amount_cents ?? null,
    remainderPercent: line.remainder_percent ?? null,
    payee: line.payee ?? null,
    toAccountId: line.to_account_id ?? null,
    depositTransactionId: line.deposit_transaction_id ?? null,
    reimbursed: line.reimbursed ?? false,
    note: line.note ?? null,
  }));
}

export function splitOut(view: SplitView) {
  return {
    transaction_id: view.id,
    kind: view.kind,
    client_key: view.clientKey,
    occurred_on: view.occurredOn,
    payee: view.payee,
    amount_cents: view.amountCents,
    account_id: view.accountId,
    account_name: view.accountName,
    note: view.note,
    lines: view.lines.map((line) => ({
      id: line.id,
      payee: line.payee,
      amount_cents: line.amountCents,
      category_id: line.categoryId,
      category_name: line.categoryName,
      category_kind: line.categoryKind,
      reimbursed: line.reimbursed,
      note: line.note,
      deposit: line.deposit ? { id: line.deposit.id, account_id: line.deposit.accountId, account_name: line.deposit.accountName, amount_cents: line.deposit.amountCents } : null,
      linked_deposit: line.linked
        ? {
            id: line.linked.id,
            account_id: line.linked.accountId,
            account_name: line.linked.accountName,
            occurred_on: line.linked.occurredOn,
            payee: line.linked.payee,
            amount_cents: line.linked.amountCents,
            deleted: line.linked.deleted,
          }
        : null,
    })),
    replaced_transactions: view.replaced.map((row) => ({ id: row.id, payee: row.payee, occurred_on: row.occurredOn, amount_cents: row.amountCents })),
  };
}

/** A refused split names the difference, so an agent can fix the lines. */
function withDifference<T>(result: ServiceResult<T>): ServiceResult<T> {
  const difference = splitDifferenceOf(result);
  if (result.ok || difference == null) return result;
  return { ...result, memberMessage: `${result.memberMessage} (difference_cents: ${difference})` };
}

const splitFields = {
  lines: linesInput.describe(`Up to ${MAX_SPLIT_LINES} lines that add up to the transaction.`),
};

export const splitTools = [
  tool({
    name: "create_split",
    title: "Split into transactions",
    description: `Turn one transaction into a parent with child transactions (lines). ${KIND_HELP} Optional client_key makes a retry safe; replaces_transaction_ids hides rows this split stands in for (they come back on unsplit).`,
    access: "write",
    idempotent: true,
    input: {
      transaction_id: uuidInput("Transaction to split"),
      ...splitFields,
      client_key: z.string().min(1).max(100).optional().describe("Your key for this split; sending it again returns the existing split instead of splitting twice."),
      replaces_transaction_ids: z.array(z.string().uuid()).max(50).optional().describe("Transactions this split replaces, e.g. a workaround's separate tax and 401(k) rows."),
    },
    async run(args, { books }) {
      const created = withDifference(
        await createSplit(
          books,
          { transactionId: args.transaction_id, lines: linesFrom(args.lines), clientKey: args.client_key ?? null, replacesTransactionIds: args.replaces_transaction_ids ?? [] },
          "mcp",
        ),
      );
      return answer(
        created,
        (value) => (value.status === "exists" ? `${value.payee} was already split with that key.` : `Split ${value.payee} into ${plural(value.lines.length, "line")}.`),
        (value) => ({ status: value.status, ...splitOut(value) }),
      );
    },
  }),
  tool({
    name: "create_splits",
    title: "Split many transactions",
    description: `Create up to ${MAX_BULK_SPLITS} splits in one call, each with a required client_key so the call can be retried safely (an existing key returns status "exists"). mode per_item (default) commits each item alone and reports each result; atomic creates all or none. ${KIND_HELP}`,
    access: "write",
    idempotent: true,
    input: {
      items: z
        .array(
          z.object({
            client_key: z.string().min(1).max(100).describe("Your stable key for this split, e.g. paycheck-2026-01-15."),
            transaction_id: uuidInput("Transaction to split"),
            ...splitFields,
            replaces_transaction_ids: z.array(z.string().uuid()).max(50).optional(),
          }),
        )
        .min(1)
        .max(MAX_BULK_SPLITS),
      mode: z.enum(["per_item", "atomic"]).optional().describe("per_item (default) or atomic."),
    },
    async run(args, { books }) {
      return answer(
        await createSplits(
          books,
          args.items.map((item) => ({
            clientKey: item.client_key,
            transactionId: item.transaction_id,
            lines: linesFrom(item.lines),
            replacesTransactionIds: item.replaces_transaction_ids ?? [],
          })),
          args.mode ?? "per_item",
          "mcp",
        ),
        (value) => `${value.created} created, ${value.existing} already there, ${value.failed} failed.`,
        (value) => ({
          created: value.created,
          existing: value.existing,
          failed: value.failed,
          results: value.results.map((row) => ({
            client_key: row.clientKey,
            transaction_id: row.transactionId,
            status: row.status,
            message: row.message ?? null,
            difference_cents: row.differenceCents ?? null,
            split: row.split ? splitOut(row.split) : null,
          })),
        }),
      );
    },
  }),
  tool({
    name: "update_split",
    title: "Edit split",
    description:
      "Change a split: replace its lines (give each linked net-pay line its deposit_transaction_id to keep the link), and optionally the parent's date, payee, note, account or amount (amount only when the parent has one category). Lines move with the parent's date and account. Without lines, the current lines are kept and re-checked.",
    access: "write",
    idempotent: true,
    input: {
      transaction_id: uuidInput("Split parent"),
      lines: linesInput.optional(),
      occurred_on: isoDateInput("New date").optional(),
      payee: z.string().min(1).max(PAYEE_MAX_LENGTH).optional(),
      note: z.string().max(NOTE_MAX_LENGTH).nullable().optional(),
      account_id: uuidInput("Account").optional(),
      amount_cents: z.number().int().safe().optional().describe("New parent amount in signed cents."),
    },
    async run(args, { books }) {
      return answer(
        withDifference(
          await updateSplit(
            books,
            {
              transactionId: args.transaction_id,
              lines: args.lines ? linesFrom(args.lines) : undefined,
              occurredOn: args.occurred_on,
              payee: args.payee,
              note: args.note,
              accountId: args.account_id,
              amountCents: args.amount_cents,
            },
            "mcp",
          ),
        ),
        (value) => `Saved the split of ${value.payee}.`,
        splitOut,
      );
    },
  }),
  tool({
    name: "unsplit_transaction",
    title: "Unsplit",
    description: "Remove a split's lines and deposits so the original transaction counts on its own again. Rows the split replaced come back.",
    access: "write",
    destructive: true,
    input: { transaction_id: uuidInput("Split parent"), confirm: confirmInput("remove this split's lines") },
    async run(args, { books }) {
      return answer(
        await unsplitTransaction(books, args.transaction_id, "mcp"),
        (value) => `Unsplit ${value.payee}; removed ${plural(value.removedLines, "line")}${value.restored > 0 ? `, brought back ${value.restored}` : ""}.`,
      );
    },
  }),
  tool({
    name: "list_splits",
    title: "List splits",
    description: "Split transactions, newest first, with their lines, deposits and the rows they replaced. Filter by kind (income or allocation), dates or client key prefix.",
    access: "read",
    input: {
      kind: z.enum(["income", "allocation"]).optional(),
      from: isoDateInput("From").optional(),
      to: isoDateInput("To").optional(),
      client_key_prefix: z.string().min(1).max(100).optional(),
      ...pageInput(25),
    },
    async run(args, { books }) {
      const page = readPage(args, 25);
      return answer(
        await listSplits(books, { kind: args.kind, from: args.from, to: args.to, clientKeyPrefix: args.client_key_prefix, limit: page.limit, offset: page.offset }),
        (value) => `${plural(value.total, "split")}.`,
        (value) => pageFrom(value.items.map(splitOut), value.total, page),
      );
    },
  }),
  tool({
    name: "get_split",
    title: "Split details",
    description: "One split transaction with its lines, deposits and the rows it replaced.",
    access: "read",
    input: { transaction_id: uuidInput("Split parent") },
    async run(args, { books }) {
      return answer(await getSplit(books, args.transaction_id), (value) => `${value.payee}: ${plural(value.lines.length, "line")}.`, splitOut);
    },
  }),
  tool({
    name: "suggest_transfer_links",
    title: "Suggest deposits to link",
    description: `For a paycheck split (or one of its transfer lines): deposits already in other accounts for the same amount within a few days, nearest first, that could be the net pay. Read-only: nothing is linked until you call link_transfer.`,
    access: "read",
    input: { transaction_id: uuidInput("Paycheck split or one of its lines") },
    async run(args, { books }) {
      return answer(
        await suggestTransferLinks(books, args.transaction_id),
        (value) => `${plural(value.lines.reduce((total, line) => total + line.candidates.length, 0), "possible deposit")} for ${plural(value.lines.length, "transfer line")}.`,
        (value) => ({
          parent_transaction_id: value.parentId,
          lines: value.lines.map((line) => ({
            line_transaction_id: line.lineId,
            payee: line.linePayee,
            amount_cents: line.lineAmountCents,
            occurred_on: line.occurredOn,
            linked_deposit_id: line.linked?.id ?? null,
            candidates: line.candidates.map((row) => ({
              deposit_transaction_id: row.id,
              account_id: row.accountId,
              account_name: row.accountName,
              occurred_on: row.occurredOn,
              payee: row.payee,
              amount_cents: row.amountCents,
              days_apart: row.daysApart,
            })),
          })),
        }),
      );
    },
  }),
  tool({
    name: "link_transfer",
    title: "Link deposit",
    description:
      "Link a paycheck's net-pay line to the deposit already in another account (same amount, opposite sign). The deposit takes the line's transfer category, so it stops counting as income and the account counts the money once; its old categories come back on unlink_transfer. One link per row. Linking the same pair again is a no-op.",
    access: "write",
    idempotent: true,
    input: { line_transaction_id: uuidInput("Net-pay line"), deposit_transaction_id: uuidInput("Deposit") },
    async run(args, { books }) {
      return answer(
        withDifference(await linkTransfer(books, { lineTransactionId: args.line_transaction_id, depositTransactionId: args.deposit_transaction_id }, "mcp")),
        (value) => (value.status === "exists" ? "That deposit was already linked." : `Linked ${value.parentPayee}'s net pay to the deposit in ${value.deposit.accountName}.`),
        (value) => ({
          status: value.status,
          line_transaction_id: value.lineId,
          parent_transaction_id: value.parentId,
          deposit_transaction_id: value.deposit.id,
          account_name: value.deposit.accountName,
          amount_cents: value.deposit.amountCents,
        }),
      );
    },
  }),
  tool({
    name: "unlink_transfer",
    title: "Unlink deposit",
    description: "Unlink a net-pay line from its deposit, by either side. The deposit gets back the categories it had before it was linked.",
    access: "write",
    idempotent: true,
    input: { transaction_id: uuidInput("Net-pay line or linked deposit") },
    async run(args, { books }) {
      return answer(
        await unlinkTransfer(books, args.transaction_id, "mcp"),
        (value) => (value.restoredCategories ? "Unlinked; the deposit has its old categories back." : "Unlinked."),
        (value) => ({ line_transaction_id: value.lineId, deposit_transaction_id: value.depositId, restored_categories: value.restoredCategories }),
      );
    },
  }),
];
