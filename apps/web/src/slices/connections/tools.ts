import { confirmInput, pageInput, paginate, readPage } from "@dollas/mcp";
import { answer, plural, tool, uuidInput } from "@/slices/agents/tool-kit";
import { bankConnectionStatus, disconnectBankConnection, shownBankResult, syncBankConnection, syncMessage } from "./service";

const NO_SECRETS = "Linking a bank (SimpleFIN setup tokens, Plaid Link, bank passwords) is only in the Dollas web app; tools never see bank secrets.";

export const connectionTools = [
  tool({
    name: "list_bank_connections",
    title: "List bank connections",
    description: `Linked bank connections: provider, label, sync start date, and linked accounts with balance_cents. ${NO_SECRETS}`,
    access: "read",
    input: { ...pageInput(50) },
    async run(args, { books }) {
      return answer(
        await bankConnectionStatus(books),
        (items) => `${plural(items.length, "bank connection")}.`,
        (items) => paginate(items, readPage(args, 50)),
      );
    },
  }),
  tool({
    name: "sync_bank_connection",
    title: "Sync bank connection",
    description: "Pull new accounts, balances, and transactions from a linked bank now. Payee rules categorize new transactions.",
    access: "write",
    input: { connection_id: uuidInput("Bank connection") },
    async run(args, { books }) {
      const synced = shownBankResult(await syncBankConnection(books, args.connection_id), "Could not sync that bank.");
      return answer(synced, syncMessage);
    },
  }),
  tool({
    name: "disconnect_bank_connection",
    title: "Disconnect bank",
    description: `Disconnect a bank and delete its stored credentials. Accounts and transactions already imported stay. Linking it again needs the web app. ${NO_SECRETS}`,
    access: "write",
    destructive: true,
    input: { connection_id: uuidInput("Bank connection"), confirm: confirmInput("disconnect this bank and delete its stored credentials") },
    async run(args, { books }) {
      const removed = shownBankResult(await disconnectBankConnection(books, args.connection_id), "Could not disconnect that bank.");
      return answer(removed, () => "Disconnected that bank.", (value) => ({ provider_revoked: value.providerRevoked }));
    },
  }),
];
