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
import { withActor } from "@/db/actor";
import { bankConnection } from "@/db/schema";
import { logError, logInfo } from "@/lib/telemetry";
import type { ServiceResult } from "@/lib/service-result";
import { applyBankSync, type BankSyncCounts } from "./apply";
import { requireBankConnectionKeys } from "./keys";
import { memberBankMessage } from "./messages";
import { readPlaidEnv } from "./plaid-config";
import { loadBankConnections, type BankConnectionListItem } from "./queries";
import { bankProviderRegistry } from "./registry";
import { drizzleBankConnectionQueries } from "./store";

/**
 * Bank slice services. A page action and an MCP tool both call these.
 * They run on the server as the signed-in member. They do not read form data
 * and they do not render.
 *
 * Functions marked UI-only finish a bank login or touch provider secrets.
 * MCP must not call those. A bank password, a Plaid key, a link token, and a
 * public token are not MCP inputs or outputs. Listing connections, syncing,
 * and disconnecting are what the MCP tools call.
 */
export type BankActor = {
  userId: string;
  householdId: string;
};

export type BankServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown; memberMessage?: string };

const CONNECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Lists this household's bank connections. No tokens. The Accounts page uses this. */
export async function listBankConnections(actor: BankActor): Promise<BankConnectionListItem[]> {
  return loadBankConnections(actor);
}

export type BankConnectionStatus = {
  id: string;
  provider: string;
  label: string;
  transactionsSince: string | null;
  accounts: Array<{ name: string; balanceCents: number; currency: string }>;
};

/**
 * Connection status for MCP: provider, label, sync window, and linked
 * accounts with balances. Never the encrypted token, an access URL, a
 * provider account id, or a cursor.
 */
export async function bankConnectionStatus(actor: BankActor): Promise<ServiceResult<BankConnectionStatus[]>> {
  try {
    const listed = await loadBankConnections(actor);
    return {
      ok: true,
      value: listed.map((item) => ({
        id: item.id,
        provider: item.providerId,
        label: item.label,
        transactionsSince: item.transactionsSince,
        accounts: item.accounts.map((account) => ({ name: account.name, balanceCents: account.balanceCents, currency: account.currency })),
      })),
    };
  } catch (error) {
    logError(error, { action: "list-bank-connections", householdId: actor.householdId });
    return { ok: false, error, memberMessage: "Could not load bank connections." };
  }
}

/** Plain result with the member message filled in, for callers outside this slice. */
export function shownBankResult<T>(outcome: BankServiceResult<T>, fallback: string): ServiceResult<T> {
  if (outcome.ok) return outcome;
  return { ok: false, error: outcome.error, memberMessage: outcome.memberMessage ?? memberBankMessage(outcome.error, fallback) };
}

/**
 * UI-only. Claims a SimpleFIN setup token and stores the access URL
 * encrypted. MCP must not call this: the setup token and the access URL are
 * bank secrets and never an MCP input or output.
 */
export async function linkSimpleFinConnection(
  actor: BankActor,
  input: { token: string; label: string; sinceRaw: string },
): Promise<BankServiceResult<{ connectionId: string }>> {
  const sinceRaw = input.sinceRaw.trim();
  let since = defaultTransactionsSince(new Date());
  if (sinceRaw) {
    if (!isIsoDate(sinceRaw)) return fail(new Error("date"), "Use a start date like 2026-01-01.");
    since = sinceRaw;
  }
  const keys = readKeys(actor, "link-simplefin");
  if (!keys.ok) return keys;
  logInfo("simplefin.claim.started", { action: "link-simplefin", householdId: actor.householdId });
  try {
    const outcome = await withActor(actor.userId, async (tx) => {
      const connected = await connectBank(
        {
          registry: bankProviderRegistry(),
          store: createQueryBankConnectionStore(drizzleBankConnectionQueries(tx)),
          keys: keys.value,
        },
        {
          householdId: actor.householdId,
          providerId: SIMPLEFIN_PROVIDER_ID,
          setup: { token: input.token },
          label: input.label.trim() || undefined,
        },
      );
      if (connected.isErr()) return connected;
      await tx
        .update(bankConnection)
        .set({ transactionsSince: since })
        .where(and(eq(bankConnection.id, connected.value.id), eq(bankConnection.householdId, actor.householdId)));
      return connected;
    });
    if (outcome.isErr()) {
      logError(outcome.error, { action: "link-simplefin", householdId: actor.householdId });
      return fail(outcome.error);
    }
    logInfo("simplefin.claim.finished", { action: "link-simplefin", householdId: actor.householdId, connectionId: outcome.value.id });
    return { ok: true, value: { connectionId: outcome.value.id } };
  } catch (error) {
    logError(error, { action: "link-simplefin", householdId: actor.householdId });
    return fail(error);
  }
}

/**
 * UI-only. Creates a Plaid Link token so the browser can open Plaid Link.
 * MCP must not call this. Completing a bank login stays in the web UI.
 * Provider keys stay on the server and are not returned.
 */
export async function createPlaidLinkToken(
  actor: BankActor,
  sinceRaw: string,
): Promise<BankServiceResult<{ linkToken: string }>> {
  const decision = resolvePlaidConfig(readPlaidEnv());
  if (decision.isErr()) {
    logError(decision.error, { action: "plaid-link", householdId: actor.householdId });
    return fail(decision.error);
  }
  if (!decision.value.enabled) {
    const error = new ConfigError(
      "PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV are required for Plaid. Set all three or leave all three empty.",
    );
    logError(error, { action: "plaid-link", householdId: actor.householdId });
    return fail(new ConfigError("PLAID_ENV is required for Plaid."));
  }
  const trimmed = sinceRaw.trim();
  if (trimmed && !isIsoDate(trimmed)) return fail(new Error("date"), "Use a start date like 2026-01-01.");
  const provider = bankProviderRegistry().select(PLAID_PROVIDER_ID);
  if (provider.isErr() || !isPlaid(provider.value)) {
    const error = provider.isErr() ? provider.error : new ProviderError("Could not link that bank.");
    logError(error, { action: "plaid-link", householdId: actor.householdId });
    return fail(error, "Could not link that bank.");
  }
  logInfo("plaid.link.started", { action: "plaid-link", householdId: actor.householdId });
  let created;
  try {
    created = await provider.value.createLinkToken({
      clientUserId: actor.userId,
      daysRequested: plaidHistoryDays(trimmed || undefined, new Date()),
      redirectUri: decision.value.redirectUri,
    });
  } catch (error) {
    logError(error, { action: "plaid-link", householdId: actor.householdId });
    return fail(error);
  }
  if (created.isErr()) {
    logError(created.error, { action: "plaid-link", householdId: actor.householdId });
    return fail(created.error);
  }
  return { ok: true, value: { linkToken: created.value.linkToken } };
}

/**
 * UI-only. Exchanges the public token from Plaid Link and stores the access
 * token encrypted. MCP must not call this. The public token, the access
 * token, and the provider keys are not an MCP input or output.
 */
export async function exchangePlaidPublicToken(
  actor: BankActor,
  publicToken: string,
  label: string,
  sinceRaw: string,
): Promise<BankServiceResult<{ connectionId: string }>> {
  const trimmedSince = sinceRaw.trim();
  let since = defaultTransactionsSince(new Date());
  if (trimmedSince) {
    if (!isIsoDate(trimmedSince)) return fail(new Error("date"), "Use a start date like 2026-01-01.");
    since = trimmedSince;
  }
  const requested = label.trim();
  const safeLabel = requested.length >= 1 && requested.length <= 80 && !/[\u0000-\u001f\u007f]/.test(requested) ? requested : "Plaid";
  const keys = readKeys(actor, "plaid-exchange");
  if (!keys.ok) return keys;
  try {
    const outcome = await withActor(actor.userId, async (tx) => {
      const connected = await connectBank(
        {
          registry: bankProviderRegistry(),
          store: createQueryBankConnectionStore(drizzleBankConnectionQueries(tx)),
          keys: keys.value,
        },
        {
          householdId: actor.householdId,
          providerId: PLAID_PROVIDER_ID,
          setup: { token: publicToken },
          label: safeLabel,
        },
      );
      if (connected.isErr()) return connected;
      await tx
        .update(bankConnection)
        .set({ transactionsSince: since })
        .where(and(eq(bankConnection.id, connected.value.id), eq(bankConnection.householdId, actor.householdId)));
      return connected;
    });
    if (outcome.isErr()) {
      logError(outcome.error, { action: "plaid-exchange", householdId: actor.householdId });
      return fail(outcome.error);
    }
    logInfo("plaid.link.finished", {
      action: "plaid-exchange",
      householdId: actor.householdId,
      connectionId: outcome.value.id,
    });
    return { ok: true, value: { connectionId: outcome.value.id } };
  } catch (error) {
    logError(error, { action: "plaid-exchange", householdId: actor.householdId });
    return fail(error);
  }
}

/**
 * UI-only. These finish a bank login. MCP must not call them.
 * The entries are the functions themselves, not name strings.
 */
export const UI_ONLY_SERVICES = [
  linkSimpleFinConnection,
  createPlaidLinkToken,
  exchangePlaidPublicToken,
] as const;

/** Syncs one household connection. The Accounts page and the sync_bank_connection tool call this. */
export async function syncBankConnection(
  actor: BankActor,
  connectionId: string,
): Promise<BankServiceResult<BankSyncCounts>> {
  if (!CONNECTION_ID.test(connectionId)) return fail(new Error("id"), "That connection is not valid.");
  const keys = readKeys(actor, "sync-bank", connectionId);
  if (!keys.ok) return keys;

  let loaded: {
    providerId: string;
    encryptedAccessToken: string;
    transactionsSince: string | null;
    syncCursor: string | null;
  };
  try {
    loaded = await withActor(actor.userId, async (tx) => {
      const store = createQueryBankConnectionStore(drizzleBankConnectionQueries(tx));
      const existing = await store.get(actor.householdId, connectionId);
      if (existing.isErr()) throw existing.error;
      if (!existing.value) throw new BankConnectionError("That bank connection is not in this household.");
      const [meta] = await tx
        .select({
          transactionsSince: bankConnection.transactionsSince,
          syncCursor: bankConnection.syncCursor,
        })
        .from(bankConnection)
        .where(and(eq(bankConnection.id, connectionId), eq(bankConnection.householdId, actor.householdId)));
      return {
        providerId: existing.value.providerId,
        encryptedAccessToken: existing.value.encryptedAccessToken,
        transactionsSince: meta?.transactionsSince ?? null,
        syncCursor: meta?.syncCursor ?? null,
      };
    });
  } catch (error) {
    logError(error, { action: "sync-bank", householdId: actor.householdId, connectionId });
    return fail(error);
  }
  const since =
    loaded.transactionsSince && isIsoDate(loaded.transactionsSince)
      ? loaded.transactionsSince
      : defaultTransactionsSince(new Date());
  if (loaded.providerId === PLAID_PROVIDER_ID) {
    return syncPlaidConnection(actor, connectionId, keys.value, loaded, since);
  }
  if (loaded.providerId !== SIMPLEFIN_PROVIDER_ID) {
    return fail(new ProviderError("Sync is not available for that connection."), "Sync is not available for that connection.");
  }
  return syncSimpleFinConnection(actor, connectionId, keys.value, loaded.encryptedAccessToken, since);
}

/** Disconnects one household connection and deletes the stored token. The Accounts page and an MCP tool call this. */
export async function disconnectBankConnection(
  actor: BankActor,
  connectionId: string,
): Promise<BankServiceResult<{ providerRevoked: boolean }>> {
  if (!CONNECTION_ID.test(connectionId)) return fail(new Error("id"), "That connection is not valid.");
  const keys = readKeys(actor, "disconnect-bank", connectionId);
  if (!keys.ok) return keys;
  try {
    const outcome = await withActor(actor.userId, (tx) =>
      disconnectBank(
        {
          registry: bankProviderRegistry(),
          store: createQueryBankConnectionStore(drizzleBankConnectionQueries(tx)),
          keys: keys.value,
        },
        { householdId: actor.householdId, connectionId },
      ),
    );
    if (outcome.isErr()) {
      logError(outcome.error, {
        action: "disconnect-bank",
        householdId: actor.householdId,
        connectionId,
      });
      return fail(outcome.error);
    }
    if (!outcome.value.providerRevoked) {
      logError(new ProviderError("Disconnected locally. The provider did not confirm revocation."), {
        action: "disconnect-bank",
        householdId: actor.householdId,
        connectionId,
      });
    }
    return { ok: true, value: { providerRevoked: outcome.value.providerRevoked } };
  } catch (error) {
    logError(error, { action: "disconnect-bank", householdId: actor.householdId, connectionId });
    return fail(error);
  }
}

async function syncPlaidConnection(
  actor: BankActor,
  connectionId: string,
  keys: TokenKeyRing,
  loaded: { encryptedAccessToken: string; syncCursor: string | null },
  since: string,
): Promise<BankServiceResult<BankSyncCounts>> {
  const decision = resolvePlaidConfig(readPlaidEnv());
  if (decision.isErr() || !decision.value.enabled) {
    const error = decision.isErr()
      ? decision.error
      : new ConfigError("PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV are required for Plaid.");
    logError(error, { action: "sync-plaid", householdId: actor.householdId, connectionId });
    return fail(error);
  }
  const plain = await decryptToken(loaded.encryptedAccessToken, keys, { householdId: actor.householdId });
  if (plain.isErr()) {
    logError(plain.error, { action: "sync-plaid", householdId: actor.householdId, connectionId });
    return fail(plain.error);
  }
  const provider = bankProviderRegistry().select(PLAID_PROVIDER_ID);
  if (provider.isErr() || !isPlaid(provider.value)) {
    const error = provider.isErr() ? provider.error : new ProviderError("Could not sync that bank.");
    logError(error, { action: "sync-plaid", householdId: actor.householdId, connectionId });
    return fail(error, "Could not sync that bank.");
  }
  logInfo("plaid.sync.started", { action: "sync-plaid", householdId: actor.householdId, connectionId });
  let snapshot;
  try {
    snapshot = await provider.value.syncItem(
      { accessToken: plain.value },
      { cursor: loaded.syncCursor, since, includePending: false },
    );
  } catch (error) {
    logError(error, { action: "sync-plaid", householdId: actor.householdId, connectionId });
    return fail(error);
  }
  if (snapshot.isErr()) {
    logError(snapshot.error, { action: "sync-plaid", householdId: actor.householdId, connectionId });
    return fail(snapshot.error);
  }
  if (snapshot.value.accounts.length === 0) {
    return fail(
      new ProviderError("The bank did not return any accounts."),
      "The bank did not return any accounts. Check the connection at your bank, then try syncing again.",
    );
  }
  const synced = snapshot.value;
  try {
    const written = await withActor(actor.userId, (tx) =>
      applyBankSync(tx, {
        householdId: actor.householdId,
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
      householdId: actor.householdId,
      connectionId,
      accounts: String(written.accounts),
      transactions: String(written.transactions),
      matched: String(written.matched),
      updated: String(written.updated),
      removed: String(written.removed),
    });
    return { ok: true, value: written };
  } catch (error) {
    logError(error, { action: "sync-plaid", householdId: actor.householdId, connectionId });
    return fail(error);
  }
}

async function syncSimpleFinConnection(
  actor: BankActor,
  connectionId: string,
  keys: TokenKeyRing,
  encryptedAccessToken: string,
  since: string,
): Promise<BankServiceResult<BankSyncCounts>> {
  const plain = await decryptToken(encryptedAccessToken, keys, { householdId: actor.householdId });
  if (plain.isErr()) {
    logError(plain.error, { action: "sync-simplefin", householdId: actor.householdId, connectionId });
    return fail(plain.error);
  }
  const provider = bankProviderRegistry().select(SIMPLEFIN_PROVIDER_ID);
  if (provider.isErr() || !isSimpleFin(provider.value)) {
    const error = provider.isErr() ? provider.error : new ProviderError("Could not sync that bank.");
    logError(error, { action: "sync-simplefin", householdId: actor.householdId, connectionId });
    return fail(error, "Could not sync that bank.");
  }

  logInfo("simplefin.sync.started", { action: "sync-simplefin", householdId: actor.householdId, connectionId });
  let snapshot;
  try {
    snapshot = await provider.value.readBooks({ accessToken: plain.value }, { since, includePending: false });
  } catch (error) {
    logError(error, { action: "sync-simplefin", householdId: actor.householdId, connectionId });
    return fail(error);
  }
  if (snapshot.isErr()) {
    logError(snapshot.error, { action: "sync-simplefin", householdId: actor.householdId, connectionId });
    return fail(snapshot.error);
  }
  if (snapshot.value.noticeCount > 0) {
    logInfo("simplefin.sync.notices", {
      action: "sync-simplefin",
      householdId: actor.householdId,
      connectionId,
      notices: String(snapshot.value.noticeCount),
    });
  }
  const synced = snapshot.value;
  if (synced.accounts.length === 0) {
    return fail(
      new ProviderError("The bank did not return any accounts."),
      "The bank did not return any accounts. Check the connection at your bank, then try syncing again.",
    );
  }

  try {
    const written = await withActor(actor.userId, (tx) =>
      applyBankSync(tx, {
        householdId: actor.householdId,
        connectionId,
        providerId: SIMPLEFIN_PROVIDER_ID,
        since,
        accounts: synced.accounts,
        transactions: synced.transactions,
      }),
    );
    logInfo("simplefin.sync.finished", {
      action: "sync-simplefin",
      householdId: actor.householdId,
      connectionId,
      accounts: String(written.accounts),
      transactions: String(written.transactions),
      matched: String(written.matched),
    });
    return {
      ok: true,
      value: written,
    };
  } catch (error) {
    logError(error, { action: "sync-simplefin", householdId: actor.householdId, connectionId });
    return fail(error);
  }
}

function readKeys(
  actor: BankActor,
  action: string,
  connectionId?: string,
): BankServiceResult<TokenKeyRing> {
  try {
    return { ok: true, value: requireBankConnectionKeys() };
  } catch (error) {
    logError(error, { action, householdId: actor.householdId, ...(connectionId ? { connectionId } : {}) });
    return fail(error);
  }
}

function fail(error: unknown, memberMessage?: string): { ok: false; error: unknown; memberMessage?: string } {
  return memberMessage === undefined ? { ok: false, error } : { ok: false, error, memberMessage };
}

function isSimpleFin(provider: BankProvider): provider is SimpleFinProvider {
  return provider.id === SIMPLEFIN_PROVIDER_ID && "readBooks" in provider;
}

function isPlaid(provider: BankProvider): provider is PlaidProvider {
  return provider.id === PLAID_PROVIDER_ID && "syncItem" in provider;
}

/** One sentence about what a sync wrote. */
export function syncMessage(written: BankSyncCounts): string {
  const accountLabel = written.accounts === 1 ? "account" : "accounts";
  const carried = written.reconnected?.transactions ?? 0;
  const reconnected =
    (written.reconnected?.accounts ?? 0) > 0 || carried > 0
      ? ` Picked up where the earlier connection left off${carried > 0 ? `: ${carried} ${carried === 1 ? "transaction" : "transactions"} already in Dollas, not added again` : ""}.`
      : "";
  if (written.transactions === 0 && written.matched === 0 && written.updated === 0 && written.removed === 0) {
    return `Updated ${written.accounts} ${accountLabel}. No new transactions.${reconnected}`;
  }
  const parts = [`Synced ${written.accounts} ${accountLabel}`];
  if (written.transactions > 0) {
    parts.push(`added ${written.transactions} ${written.transactions === 1 ? "transaction" : "transactions"}`);
  }
  if (written.matched > 0) parts.push(`matched ${written.matched} you already had`);
  if (written.updated > 0) parts.push(`updated ${written.updated}`);
  if (written.removed > 0) parts.push(`hid ${written.removed} removed by the bank`);
  if (parts.length === 1) return `${parts[0]}.${reconnected}`;
  return `${parts[0]} and ${parts.slice(1).join(", ")}.${reconnected}`;
}
