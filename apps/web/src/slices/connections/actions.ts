"use server";

import {
  BankConnectionError,
  connectBank,
  createQueryBankConnectionStore,
  decryptToken,
  defaultTransactionsSince,
  disconnectBank,
  isIsoDate,
  ProviderError,
  SIMPLEFIN_PROVIDER_ID,
  type BankProvider,
  type SimpleFinProvider,
} from "@dollas/domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withActor } from "@/db/actor";
import { bankConnection } from "@/db/schema";
import { logError, logInfo } from "@/lib/telemetry";
import { requireBooks } from "@/slices/access/guard";
import { applyBankSync } from "./apply";
import { requireBankConnectionKeys } from "./keys";
import { memberBankMessage } from "./messages";
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

  let loaded: { providerId: string; encryptedAccessToken: string; transactionsSince: string | null };
  try {
    loaded = await withActor(books.userId, async (tx) => {
      const store = createQueryBankConnectionStore(drizzleBankConnectionQueries(tx));
      const existing = await store.get(books.householdId, connectionId);
      if (existing.isErr()) throw existing.error;
      if (!existing.value) throw new BankConnectionError("That bank connection is not in this household.");
      const [meta] = await tx
        .select({ transactionsSince: bankConnection.transactionsSince })
        .from(bankConnection)
        .where(and(eq(bankConnection.id, connectionId), eq(bankConnection.householdId, books.householdId)));
      return {
        providerId: existing.value.providerId,
        encryptedAccessToken: existing.value.encryptedAccessToken,
        transactionsSince: meta?.transactionsSince ?? null,
      };
    });
  } catch (error) {
    logError(error, { action: "sync-simplefin", householdId: books.householdId, connectionId });
    return { error: memberBankMessage(error, "Could not sync that bank."), message: "" };
  }
  if (loaded.providerId !== SIMPLEFIN_PROVIDER_ID) {
    return { error: "Sync is available for SimpleFIN connections.", message: "" };
  }

  const plain = await decryptToken(loaded.encryptedAccessToken, keys, { householdId: books.householdId });
  if (plain.isErr()) {
    logError(plain.error, { action: "sync-simplefin", householdId: books.householdId, connectionId });
    return { error: memberBankMessage(plain.error, "Could not sync that bank."), message: "" };
  }
  const since =
    loaded.transactionsSince && isIsoDate(loaded.transactionsSince)
      ? loaded.transactionsSince
      : defaultTransactionsSince(new Date());
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

function isSimpleFin(provider: BankProvider): provider is SimpleFinProvider {
  return provider.id === SIMPLEFIN_PROVIDER_ID && "readBooks" in provider;
}

function syncMessage(accounts: number, transactions: number): string {
  const accountLabel = accounts === 1 ? "account" : "accounts";
  if (transactions === 0) return `Updated ${accounts} ${accountLabel}. No new transactions.`;
  const transactionLabel = transactions === 1 ? "transaction" : "transactions";
  return `Synced ${accounts} ${accountLabel} and added ${transactions} ${transactionLabel}.`;
}

function revalidateBooks() {
  revalidatePath("/accounts");
  revalidatePath("/activity");
  revalidatePath("/");
  revalidatePath("/plan");
  revalidatePath("/history");
  revalidatePath("/projection");
}
