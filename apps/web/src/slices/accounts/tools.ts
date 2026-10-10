import { accountTypes } from "@dollas/domain";
import { confirmInput, pageInput, paginate, readPage } from "@dollas/mcp";
import { z } from "zod";
import { answer, centsInput, decimalText, money, plural, tool, uuidInput } from "@/slices/agents/tool-kit";
import {
  addHouseholdAccount,
  archiveHouseholdAccount,
  deleteHouseholdAccount,
  listHouseholdAccounts,
  unarchiveHouseholdAccount,
  updateHouseholdAccount,
} from "./service";

const openingInput = {
  opening_balance_cents: centsInput("Opening balance, zero or more").min(0).optional().describe("Opening balance in integer cents, zero or more. Defaults to 0."),
  owed: z.boolean().optional().describe("Credit accounts only: the opening balance is owed."),
};

export const accountTools = [
  tool({
    name: "list_accounts",
    title: "List accounts",
    description:
      "Accounts in the household with balance_cents (integer cents; negative means owed). Archived accounts are left out unless include_archived is true.",
    access: "read",
    input: { include_archived: z.boolean().optional().describe("Include archived accounts."), ...pageInput(100) },
    async run(args, { books }) {
      const listed = await listHouseholdAccounts(books, { includeArchived: args.include_archived ?? false });
      return answer(
        listed,
        (items) => `${plural(items.length, "account")}.`,
        (items) =>
          paginate(
            items.map((item) => ({
              id: item.id,
              name: item.name,
              type: item.type,
              balance_cents: item.balanceCents,
              opening_balance_cents: item.openingBalanceCents,
              transaction_count: item.transactionCount,
              archived: item.archivedAt !== null,
            })),
            readPage(args, 100),
          ),
      );
    },
  }),
  tool({
    name: "create_account",
    title: "Create account",
    description: "Add a manual account (checking, savings, credit, or cash) with an opening balance in integer cents.",
    access: "write",
    input: { name: z.string().min(1).max(80).describe("Account name."), type: z.enum(accountTypes).describe("Account type."), ...openingInput },
    async run(args, { books }) {
      const cents = args.opening_balance_cents ?? 0;
      const added = await addHouseholdAccount(books, { name: args.name, type: args.type, opening: decimalText(cents), owed: args.owed ?? false }, "mcp");
      return answer(added, (value) => `Added ${value.name} (${value.type}) opening at ${money(value.openingBalanceCents, books)}.`, (value) => ({
        id: value.id,
        name: value.name,
        type: value.type,
        opening_balance_cents: value.openingBalanceCents,
      }));
    },
  }),
  tool({
    name: "update_account",
    title: "Update account",
    description: "Rename an account and set its opening balance in integer cents. Both fields are saved together, like the Accounts page edit form.",
    access: "write",
    idempotent: true,
    input: { account_id: uuidInput("Account"), name: z.string().min(1).max(80).describe("Account name."), ...openingInput },
    async run(args, { books }) {
      const edited = await updateHouseholdAccount(
        books,
        args.account_id,
        { name: args.name, opening: decimalText(args.opening_balance_cents ?? 0), owed: args.owed ?? false },
        "mcp",
      );
      return answer(edited, (value) => `Saved ${value.name}.`, (value) => ({
        id: value.id,
        name: value.name,
        opening_balance_cents: value.openingBalanceCents,
      }));
    },
  }),
  tool({
    name: "archive_account",
    title: "Archive account",
    description: "Archive an account. It leaves active lists and takes no new transactions; its history stays. unarchive_account brings it back.",
    access: "write",
    idempotent: true,
    input: { account_id: uuidInput("Account") },
    async run(args, { books }) {
      return answer(await archiveHouseholdAccount(books, args.account_id, "mcp"), () => "Archived that account.", (value) => ({
        id: value.id,
        archived_at: value.archivedAt,
      }));
    },
  }),
  tool({
    name: "unarchive_account",
    title: "Unarchive account",
    description: "Bring an archived account back to active lists.",
    access: "write",
    idempotent: true,
    input: { account_id: uuidInput("Account") },
    async run(args, { books }) {
      return answer(await unarchiveHouseholdAccount(books, args.account_id, "mcp"), () => "That account is active again.");
    },
  }),
  tool({
    name: "delete_account",
    title: "Delete account",
    description: "Permanently delete an account that has no transactions. Accounts with history can only be archived.",
    access: "write",
    destructive: true,
    input: { account_id: uuidInput("Account"), confirm: confirmInput("permanently delete this account") },
    async run(args, { books }) {
      return answer(await deleteHouseholdAccount(books, args.account_id, "mcp"), (value) => `Deleted ${value.name}.`);
    },
  }),
];
