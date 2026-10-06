"use server";

import {
  BankConnectionError,
  ConfigError,
  connectBank,
  createQueryBankConnectionStore,
  decryptToken,
  defaultTransactionsSince,
  disconnectBank,
  isIsoDate,
  PLAID_PROVIDER_ID,
  plaidHistoryDays,
  ProviderError,
  resolvePlaidConfig,
  SIMPLEFIN_PROVIDER_ID,
  type BankProvider,
  type PlaidProvider,
  type SimpleFinProvider,
  type TokenKeyRing,
} from "@dollas/domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withActor } from "@/db/actor";
import { bankConnection } from "@/db/schema";
import { logError, logInfo } from "@/lib/telemetry";
import { requireBooks, type BooksContext } from "@/slices/access/guard";
import { applyBankSync } from "./apply";
import { requireBankConnectionKeys } from "./keys";
import { memberBankMessage } from "./messages";
import { readPlaidEnv } from "./plaid-config";
import { bankProviderRegistry } from "./registry";
import { drizzleBankConnectionQueries } from "./store";

const CONNECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type BankFormState = { error: string; message: string };

export async function linkSimpleFinAction(_state: BankFormState, formData: FormData): Promise<BankFormState> {
  const books = await requireBooks();
  const token = String(formData.get("token") ?? "");
  const label = String(formData.get("label") ?? "").trim();
  const sinceRaw = String(formData.get("since") ?? "").trim();
  let since = defaultTransactionsSince(new Date());
  if (sinceRaw) {
    if (!isIsoDate(sinceRaw)) return { error: "Use a start date like 2026-01-01.", message: "" };
    since = sinceRaw;
  }
  let keys;
  try {
    keys = requireBankConnectionKeys();
  } catch (error) {
    logError(error, { action: "link-simplefin", householdId: books.householdId });
    return { error: memberBankMessage(error, "Could not link that bank."), message: "" };
  }
  logInfo("simplefin.claim.started", { action: "link-simplefin", householdId: books.householdId });
  try {
    const outcome = await withActor(books.userId, async (tx) => {
      const connected = await connectBank(
        {
          registry: bankProviderRegistry(),
          store: createQueryBankConnectionStore(drizzleBankConnectionQueries(tx)),
          keys,
        },
        {
          householdId: books.householdId,
          providerId: SIMPLEFIN_PROVIDER_ID,
          setup: { token },
          label: label || undefined,
        },
      );
      if (connected.isErr()) return connected;
      await tx
        .update(bankConnection)
        .set({ transactionsSince: since })
        .where(and(eq(bankConnection.id, connected.value.id), eq(bankConnection.householdId, books.householdId)));
      return connected;
    });
    if (outcome.isErr()) {
      logError(outcome.error, { action: "link-simplefin", householdId: books.householdId });
      return { error: memberBankMessage(outcome.error, "Could not link that bank."), message: "" };
    }
    logInfo("simplefin.claim.finished", {
      action: "link-simplefin",
      householdId: books.householdId,
      connectionId: outcome.value.id,
    });
  } catch (error) {
    logError(error, { action: "link-simplefin", householdId: books.householdId });
    return { error: memberBankMessage(error, "Could not link that bank."), message: "" };
  }
  revalidateBooks();
  return { error: "", message: "SimpleFIN is linked. Sync to bring in accounts and transactions." };
}

export async function syncBankConnectionAction(_state: BankFormState, formData: FormData): Promise<BankFormState> {
  const books = await requireBooks();
  const connectionId = String(formData.get("connectionId") ?? "");
  if (!CONNECTION_ID.test(connectionId)) return { error: "That connection is not valid.", message: "" };
  let keys;
  try {
    keys = requireBankConnectionKeys();
  } catch (error) {
    logError(error, { action: "sync-simplefin", householdId: books.householdId, connectionId });
    return { error: memberBankMessage(error, "Could not sync that bank."), message: "" };
  }

  let loaded: {
    providerId: string;
    encryptedAccessToken: string;
    transactionsSince: string | null;
    syncCursor: string | null;
  };
  try {
    loaded = await withActor(books.userId, async (tx) => {
      const store = createQueryBankConnectionStore(drizzleBankConnectionQueries(tx));
      const existing = await store.get(books.householdId, connectionId);
      if (existing.isErr()) throw existing.error;
      if (!existing.value) throw new BankConnectionError("That bank connection is not in this household.");
      const [meta] = await tx
        .select({
          transactionsSince: bankConnection.transactionsSince,
          syncCursor: bankConnection.syncCursor,
        })
        .from(bankConnection)
        .where(and(eq(bankConnection.id, connectionId), eq(bankConnection.householdId, books.householdId)));
      return {
        providerId: existing.value.providerId,
        encryptedAccessToken: existing.value.encryptedAccessToken,
        transactionsSince: meta?.transactionsSince ?? null,
        syncCursor: meta?.syncCursor ?? null,
      };
    });
  } catch (error) {
    logError(error, { action: "sync-bank", householdId: books.householdId, connectionId });
    return { error: memberBankMessage(error, "Could not sync that bank."), message: "" };
  }
  const since =
    loaded.transactionsSince && isIsoDate(loaded.transactionsSince)
      ? loaded.transactionsSince
      : defaultTransactionsSince(new Date());
  if (loaded.providerId === PLAID_PROVIDER_ID) {
    return syncPlaidConnection(books, connectionId, keys, loaded, since);
  }
  if (loaded.providerId !== SIMPLEFIN_PROVIDER_ID) {
    return { error: "Sync is not available for that connection.", message: "" };
  }

  const plain = await decryptToken(loaded.encryptedAccessToken, keys, { householdId: books.householdId });
  if (plain.isErr()) {
    logError(plain.error, { action: "sync-simplefin", householdId: books.householdId, connectionId });
    return { error: memberBankMessage(plain.error, "Could not sync that bank."), message: "" };
  }
  const provider = bankProviderRegistry().select(SIMPLEFIN_PROVIDER_ID);
  if (provider.isErr() || !isSimpleFin(provider.value)) {
    const error = provider.isErr() ? provider.error : new ProviderError("Could not sync that bank.");
    logError(error, { action: "sync-simplefin", householdId: books.householdId, connectionId });
    return { error: "Could not sync that bank.", message: "" };
  }

  logInfo("simplefin.sync.started", { action: "sync-simplefin", householdId: books.householdId, connectionId });
  let snapshot;
  try {
    snapshot = await provider.value.readBooks({ accessToken: plain.value }, { since, includePending: false });
  } catch (error) {
    logError(error, { action: "sync-simplefin", householdId: books.householdId, connectionId });
    return { error: memberBankMessage(error, "Could not sync that bank."), message: "" };
  }
  if (snapshot.isErr()) {
    logError(snapshot.error, { action: "sync-simplefin", householdId: books.householdId, connectionId });
    return { error: memberBankMessage(snapshot.error, "Could not sync that bank."), message: "" };
  }
  if (snapshot.value.noticeCount > 0) {
    logInfo("simplefin.sync.notices", {
      action: "sync-simplefin",
      householdId: books.householdId,
      connectionId,
      notices: String(snapshot.value.noticeCount),
    });
  }
  const synced = snapshot.value;
  if (synced.accounts.length === 0) {
    return {
      error: "The bank did not return any accounts. Check the connection at your bank, then try syncing again.",
      message: "",
    };
  }

  try {
    const written = await withActor(books.userId, (tx) =>
      applyBankSync(tx, {
        householdId: books.householdId,
        connectionId,
        providerId: SIMPLEFIN_PROVIDER_ID,
        since,
        accounts: synced.accounts,
        transactions: synced.transactions,
      }),
    );
    logInfo("simplefin.sync.finished", {
      action: "sync-simplefin",
      householdId: books.householdId,
      connectionId,
      accounts: String(written.accounts),
      transactions: String(written.transactions),
    });
    revalidateBooks();
    return { error: "", message: syncMessage(written.accounts, written.transactions) };
  } catch (error) {
    logError(error, { action: "sync-simplefin", householdId: books.householdId, connectionId });
    return { error: memberBankMessage(error, "Could not sync that bank."), message: "" };
  }
}

export async function disconnectBankConnectionAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const connectionId = String(formData.get("connectionId") ?? "");
  if (!CONNECTION_ID.test(connectionId)) return { error: "That connection is not valid." };
  let keys;
  try {
    keys = requireBankConnectionKeys();
  } catch (error) {
    logError(error, { action: "disconnect-bank", householdId: books.householdId, connectionId });
    return { error: memberBankMessage(error, "Could not disconnect that bank.") };
  }
  try {
    const outcome = await withActor(books.userId, (tx) =>
      disconnectBank(
        {
          registry: bankProviderRegistry(),
          store: createQueryBankConnectionStore(drizzleBankConnectionQueries(tx)),
          keys,
        },
        { householdId: books.householdId, connectionId },
      ),
    );
    if (outcome.isErr()) {
      logError(outcome.error, {
        action: "disconnect-bank",
        householdId: books.householdId,
        connectionId,
      });
      return { error: memberBankMessage(outcome.error, "Could not disconnect that bank.") };
    }
    if (!outcome.value.providerRevoked) {
      logError(new ProviderError("Disconnected locally. The provider did not confirm revocation."), {
        action: "disconnect-bank",
        householdId: books.householdId,
        connectionId,
      });
    }
  } catch (error) {
    logError(error, { action: "disconnect-bank", householdId: books.householdId, connectionId });
    return { error: memberBankMessage(error, "Could not disconnect that bank.") };
  }
  revalidatePath("/accounts");
  return { error: "" };
}

export async function createPlaidLinkTokenAction(sinceRaw: string): Promise<{ error: string; linkToken: string }> {
  const books = await requireBooks();
  const decision = resolvePlaidConfig(readPlaidEnv());
  if (decision.isErr()) {
    logError(decision.error, { action: "plaid-link", householdId: books.householdId });
    return { error: memberBankMessage(decision.error, "Could not link that bank."), linkToken: "" };
  }
  if (!decision.value.enabled) {
    logError(
      new ConfigError(
        "PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV are required for Plaid. Set all three or leave all three empty.",
      ),
      { action: "plaid-link", householdId: books.householdId },
    );
    return { error: memberBankMessage(new ConfigError("PLAID_ENV is required for Plaid."), "Could not link that bank."), linkToken: "" };
  }
  const trimmed = sinceRaw.trim();
  if (trimmed && !isIsoDate(trimmed)) return { error: "Use a start date like 2026-01-01.", linkToken: "" };
  const provider = bankProviderRegistry().select(PLAID_PROVIDER_ID);
  if (provider.isErr() || !isPlaid(provider.value)) {
    const error = provider.isErr() ? provider.error : new ProviderError("Could not link that bank.");
    logError(error, { action: "plaid-link", householdId: books.householdId });
    return { error: "Could not link that bank.", linkToken: "" };
  }
  logInfo("plaid.link.started", { action: "plaid-link", householdId: books.householdId });
  let created;
  try {
    created = await provider.value.createLinkToken({
      clientUserId: books.userId,
      daysRequested: plaidHistoryDays(trimmed || undefined, new Date()),
      redirectUri: decision.value.redirectUri,
    });
  } catch (error) {
    logError(error, { action: "plaid-link", householdId: books.householdId });
    return { error: memberBankMessage(error, "Could not link that bank."), linkToken: "" };
  }
  if (created.isErr()) {
    logError(created.error, { action: "plaid-link", householdId: books.householdId });
    return { error: memberBankMessage(created.error, "Could not link that bank."), linkToken: "" };
  }
  return { error: "", linkToken: created.value.linkToken };
}

export async function linkPlaidAction(publicToken: string, label: string, sinceRaw: string): Promise<BankFormState> {
  const books = await requireBooks();
  const trimmedSince = sinceRaw.trim();
  let since = defaultTransactionsSince(new Date());
  if (trimmedSince) {
    if (!isIsoDate(trimmedSince)) return { error: "Use a start date like 2026-01-01.", message: "" };
    since = trimmedSince;
  }
  const requested = label.trim();
  const safeLabel = requested.length >= 1 && requested.length <= 80 && !/[\u0000-\u001f\u007f]/.test(requested) ? requested : "Plaid";
  let keys;
  try {
    keys = requireBankConnectionKeys();
  } catch (error) {
    logError(error, { action: "plaid-exchange", householdId: books.householdId });
    return { error: memberBankMessage(error, "Could not link that bank."), message: "" };
  }
  try {
    const outcome = await withActor(books.userId, async (tx) => {
      const connected = await connectBank(
        {
          registry: bankProviderRegistry(),
          store: createQueryBankConnectionStore(drizzleBankConnectionQueries(tx)),
          keys,
        },
        {
          householdId: books.householdId,
          providerId: PLAID_PROVIDER_ID,
          setup: { token: publicToken },
          label: safeLabel,
        },
      );
      if (connected.isErr()) return connected;
      await tx
        .update(bankConnection)
        .set({ transactionsSince: since })
        .where(and(eq(bankConnection.id, connected.value.id), eq(bankConnection.householdId, books.householdId)));
      return connected;
    });
    if (outcome.isErr()) {
      logError(outcome.error, { action: "plaid-exchange", householdId: books.householdId });
      return { error: memberBankMessage(outcome.error, "Could not link that bank."), message: "" };
    }
    logInfo("plaid.link.finished", {
      action: "plaid-exchange",
      householdId: books.householdId,
      connectionId: outcome.value.id,
    });
  } catch (error) {
    logError(error, { action: "plaid-exchange", householdId: books.householdId });
    return { error: memberBankMessage(error, "Could not link that bank."), message: "" };
  }
  revalidateBooks();
  return { error: "", message: "Plaid is linked. Sync to bring in accounts and transactions." };
}

async function syncPlaidConnection(
  books: BooksContext,
  connectionId: string,
  keys: TokenKeyRing,
  loaded: { encryptedAccessToken: string; syncCursor: string | null },
  since: string,
): Promise<BankFormState> {
  const decision = resolvePlaidConfig(readPlaidEnv());
  if (decision.isErr() || !decision.value.enabled) {
    const error = decision.isErr()
      ? decision.error
      : new ConfigError("PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV are required for Plaid.");
    logError(error, { action: "sync-plaid", householdId: books.householdId, connectionId });
    return { error: memberBankMessage(error, "Could not sync that bank."), message: "" };
  }
  const plain = await decryptToken(loaded.encryptedAccessToken, keys, { householdId: books.householdId });
  if (plain.isErr()) {
    logError(plain.error, { action: "sync-plaid", householdId: books.householdId, connectionId });
    return { error: memberBankMessage(plain.error, "Could not sync that bank."), message: "" };
  }
  const provider = bankProviderRegistry().select(PLAID_PROVIDER_ID);
  if (provider.isErr() || !isPlaid(provider.value)) {
    const error = provider.isErr() ? provider.error : new ProviderError("Could not sync that bank.");
    logError(error, { action: "sync-plaid", householdId: books.householdId, connectionId });
    return { error: "Could not sync that bank.", message: "" };
  }
  logInfo("plaid.sync.started", { action: "sync-plaid", householdId: books.householdId, connectionId });
  let snapshot;
  try {
    snapshot = await provider.value.syncItem(
      { accessToken: plain.value },
      { cursor: loaded.syncCursor, since, includePending: false },
    );
  } catch (error) {
    logError(error, { action: "sync-plaid", householdId: books.householdId, connectionId });
    return { error: memberBankMessage(error, "Could not sync that bank."), message: "" };
  }
  if (snapshot.isErr()) {
    logError(snapshot.error, { action: "sync-plaid", householdId: books.householdId, connectionId });
    return { error: memberBankMessage(snapshot.error, "Could not sync that bank."), message: "" };
  }
  if (snapshot.value.accounts.length === 0) {
    return {
      error: "The bank did not return any accounts. Check the connection at your bank, then try syncing again.",
      message: "",
    };
  }
  const synced = snapshot.value;
  try {
    const written = await withActor(books.userId, (tx) =>
      applyBankSync(tx, {
        householdId: books.householdId,
        connectionId,
        providerId: PLAID_PROVIDER_ID,
        since,
        accounts: synced.accounts,
        transactions: synced.added,
        modified: synced.modified,
        removed: synced.removed,
        nextCursor: synced.nextCursor,
      }),
    );
    logInfo("plaid.sync.finished", {
      action: "sync-plaid",
      householdId: books.householdId,
      connectionId,
      accounts: String(written.accounts),
      transactions: String(written.transactions),
      updated: String(written.updated),
      removed: String(written.removed),
    });
    revalidateBooks();
    return { error: "", message: syncMessage(written.accounts, written.transactions, written.updated, written.removed) };
  } catch (error) {
    logError(error, { action: "sync-plaid", householdId: books.householdId, connectionId });
    return { error: memberBankMessage(error, "Could not sync that bank."), message: "" };
  }
}

function isSimpleFin(provider: BankProvider): provider is SimpleFinProvider {
  return provider.id === SIMPLEFIN_PROVIDER_ID && "readBooks" in provider;
}

function isPlaid(provider: BankProvider): provider is PlaidProvider {
  return provider.id === PLAID_PROVIDER_ID && "syncItem" in provider;
}

function syncMessage(accounts: number, transactions: number, updated = 0, removed = 0): string {
  const accountLabel = accounts === 1 ? "account" : "accounts";
  if (transactions === 0 && updated === 0 && removed === 0) return `Updated ${accounts} ${accountLabel}. No new transactions.`;
  const parts = [`Synced ${accounts} ${accountLabel}`];
  if (transactions > 0) {
    parts.push(`added ${transactions} ${transactions === 1 ? "transaction" : "transactions"}`);
  }
  if (updated > 0) parts.push(`updated ${updated}`);
  if (removed > 0) parts.push(`hid ${removed} removed by the bank`);
  if (parts.length === 1) return `${parts[0]}.`;
  return `${parts[0]} and ${parts.slice(1).join(", ")}.`;
}

function revalidateBooks() {
  revalidatePath("/accounts");
  revalidatePath("/activity");
  revalidatePath("/");
  revalidatePath("/plan");
  revalidatePath("/history");
  revalidatePath("/projection");
}
