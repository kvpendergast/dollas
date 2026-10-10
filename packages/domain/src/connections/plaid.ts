import { err, ok, type Result } from "neverthrow";
import {
  ConfigError,
  InvalidSetupTokenError,
  ProviderClaimError,
  ProviderError,
  ProviderNetworkError,
  ProviderSyncError,
} from "../errors";
import type { Cents } from "../money/cents";
import {
  readProviderSetup,
  type BankProvider,
  type ProviderAccess,
  type ProviderAccount,
  type ProviderAccountType,
  type ProviderTransaction,
  type TransactionQuery,
} from "./provider";

export const PLAID_PROVIDER_ID = "plaid";

const BODY_LIMIT = 2_000_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PAGE_COUNT = 100;
const MAX_PAGES = 50;
const PLAID_VERSION = "2020-09-14";

export type PlaidEnv = "sandbox" | "production";

export type PlaidCredentials = {
  clientId: string;
  secret: string;
  env: PlaidEnv;
};

export type PlaidConfigDecision =
  | { enabled: false }
  | { enabled: true; credentials: PlaidCredentials; redirectUri: string | null };

/**
 * All three settings turn Plaid on. None of them hides it.
 * A partial set or an env other than sandbox or production is a deployer
 * mistake: the option stays hidden, and the error names the setting for logs.
 * Trial uses production. Values are not copied into the error.
 */
export function resolvePlaidConfig(input: {
  clientId: string;
  secret: string;
  env: string;
  redirectUri?: string;
}): Result<PlaidConfigDecision, ConfigError> {
  const clientId = input.clientId.trim();
  const secret = input.secret.trim();
  const env = input.env.trim().toLowerCase();
  if (!clientId && !secret && !env) return ok({ enabled: false });
  const missing = [
    clientId ? null : "PLAID_CLIENT_ID",
    secret ? null : "PLAID_SECRET",
    env ? null : "PLAID_ENV",
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    const verb = missing.length === 1 ? "is" : "are";
    return err(
      new ConfigError(
        `${missing.join(" and ")} ${verb} required for Plaid. Set PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV, or leave all three empty.`,
      ),
    );
  }
  if (env !== "sandbox" && env !== "production") {
    return err(
      new ConfigError(
        "PLAID_ENV must be sandbox or production. Trial uses production. Sandbox is the local fake-bank environment.",
      ),
    );
  }
  if (!isCredential(clientId) || !isCredential(secret)) {
    return err(new ConfigError("PLAID_CLIENT_ID and PLAID_SECRET must be single-line values."));
  }
  const redirect = readRedirectUri(input.redirectUri ?? "");
  if ((input.redirectUri ?? "").trim() && !redirect) {
    return err(
      new ConfigError(
        "PLAID_REDIRECT_URI must be an https URL, or http://localhost for sandbox, with no userinfo. Leave it empty when OAuth banks are not used.",
      ),
    );
  }
  return ok({
    enabled: true,
    credentials: { clientId, secret, env },
    redirectUri: redirect,
  });
}

export function plaidApiHost(env: PlaidEnv): string {
  return env === "sandbox" ? "https://sandbox.plaid.com" : "https://production.plaid.com";
}

/** Days of history to request at link time. Blank or invalid dates stay at 90. Plaid caps this at 730. */
export function plaidHistoryDays(since: string | undefined, now: Date): number {
  if (!since || !ISO_DATE.test(since)) return 90;
  const [year, month, day] = since.split("-").map(Number);
  const start = Date.UTC(year, month - 1, day);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (Number.isNaN(start) || start > today) return 90;
  const days = Math.floor((today - start) / 86_400_000) + 1;
  if (!Number.isFinite(days) || days < 1) return 90;
  return Math.min(730, days);
}

/**
 * Plaid amount is positive when money leaves the account. Dollas stores the
 * opposite sign: positive is inflow, negative is outflow, in integer cents.
 */
export function plaidAmountToCents(amount: number): Result<Cents, ProviderSyncError> {
  const cents = finiteDollarsToCents(amount);
  if (cents.isErr()) return err(cents.error);
  const flipped = -cents.value;
  if (!Number.isSafeInteger(flipped)) {
    return err(new ProviderSyncError("The bank sent an amount Dollas cannot store. Try syncing again."));
  }
  return ok(flipped);
}

export type PlaidSyncSnapshot = {
  accounts: ProviderAccount[];
  added: ProviderTransaction[];
  modified: ProviderTransaction[];
  removed: string[];
  nextCursor: string;
};

export type PlaidProvider = BankProvider & {
  createLinkToken(input: {
    clientUserId: string;
    daysRequested?: number;
    redirectUri?: string | null;
  }): Promise<Result<{ linkToken: string }, ProviderError>>;
  syncItem(
    access: ProviderAccess,
    options: { cursor: string | null; since?: string; includePending?: boolean },
  ): Promise<Result<PlaidSyncSnapshot, ProviderError>>;
};

export type PlaidProviderOptions = {
  credentials: PlaidCredentials;
  fetch?: typeof fetch;
};

type FetchLike = typeof fetch;

/**
 * Plaid adapter. Link tokens and public tokens are exchanged on the server.
 * The access token is the only credential the caller stores, and only after
 * encrypting it. Bank usernames and passwords never reach this process.
 * Disconnect calls `/item/remove` and does not log the token.
 */
export function createPlaidProvider(options: PlaidProviderOptions): PlaidProvider {
  const credentials = options.credentials;
  const fetchImpl: FetchLike = options.fetch ?? fetch;
  const host = plaidApiHost(credentials.env);
  const auth = { client_id: credentials.clientId, secret: credentials.secret };

  return {
    id: PLAID_PROVIDER_ID,
    label: "Plaid",
    async exchange(setup) {
      const parsed = readProviderSetup(setup);
      if (parsed.isErr()) return err(parsed.error);
      const response = await postPlaid(host, "/item/public_token/exchange", fetchImpl, {
        ...auth,
        public_token: parsed.value.token,
      });
      if (response.isErr()) return err(response.error);
      const accessToken = readToken(recordField(response.value, "access_token"));
      if (!accessToken) return err(new ProviderClaimError("That Plaid link expired. Start the link again."));
      return ok({ accessToken });
    },
    async listAccounts(access) {
      const response = await postPlaid(host, "/accounts/get", fetchImpl, {
        ...auth,
        access_token: access.accessToken,
      });
      if (response.isErr()) return err(response.error);
      const accounts = parseAccounts(recordField(response.value, "accounts"));
      if (accounts.isErr()) return err(accounts.error);
      return ok(accounts.value);
    },
    async fetchTransactions(access, query) {
      const snapshot = await syncItem(host, auth, fetchImpl, access.accessToken, {
        cursor: null,
        since: query.since,
        includePending: query.includePending,
      });
      if (snapshot.isErr()) return err(snapshot.error);
      const rows = [...snapshot.value.added, ...snapshot.value.modified].filter((row) => {
        if (query.providerAccountId && row.providerAccountId !== query.providerAccountId) return false;
        return true;
      });
      return ok(rows);
    },
    async disconnect(access) {
      const response = await postPlaid(host, "/item/remove", fetchImpl, {
        ...auth,
        access_token: access.accessToken,
      });
      if (response.isErr()) return err(response.error);
      return ok(undefined);
    },
    createLinkToken(input) {
      const clientUserId = input.clientUserId.trim();
      if (!isStableId(clientUserId) || clientUserId.length > 128) {
        return Promise.resolve(err(new ProviderError("Could not start Plaid Link.")));
      }
      const days = clampDays(input.daysRequested);
      const body: Record<string, unknown> = {
        ...auth,
        client_name: "Dollas",
        language: "en",
        country_codes: ["US", "CA"],
        user: { client_user_id: clientUserId },
        products: ["transactions"],
        transactions: { days_requested: days },
      };
      const redirect = input.redirectUri?.trim();
      if (redirect) body.redirect_uri = redirect;
      return createLink(host, fetchImpl, body);
    },
    syncItem(access, options) {
      return syncItem(host, auth, fetchImpl, access.accessToken, options);
    },
  };
}

async function createLink(
  host: string,
  fetchImpl: FetchLike,
  body: Record<string, unknown>,
): Promise<Result<{ linkToken: string }, ProviderError>> {
  const response = await postPlaid(host, "/link/token/create", fetchImpl, body);
  if (response.isErr()) return err(response.error);
  const linkToken = readToken(recordField(response.value, "link_token"));
  if (!linkToken) return err(new ProviderClaimError("Could not start Plaid Link. Try again."));
  return ok({ linkToken });
}

async function syncItem(
  host: string,
  auth: { client_id: string; secret: string },
  fetchImpl: FetchLike,
  accessToken: string,
  options: { cursor: string | null; since?: string; includePending?: boolean },
  attempt = 0,
): Promise<Result<PlaidSyncSnapshot, ProviderError>> {
  const added: ProviderTransaction[] = [];
  const modified: ProviderTransaction[] = [];
  const removed: string[] = [];
  const accounts = new Map<string, ProviderAccount>();
  let cursor = options.cursor ?? "";
  let nextCursor = "";

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await postPlaid(host, "/transactions/sync", fetchImpl, {
      ...auth,
      access_token: accessToken,
      cursor,
      count: PAGE_COUNT,
    });
    if (response.isErr()) {
      const code = response.error instanceof PlaidStatusError ? response.error.plaidCode : "";
      if (attempt < 1 && code === "INVALID_CURSOR" && options.cursor) {
        return syncItem(host, auth, fetchImpl, accessToken, { ...options, cursor: null }, attempt + 1);
      }
      if (attempt < 1 && code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") {
        return syncItem(host, auth, fetchImpl, accessToken, options, attempt + 1);
      }
      return err(response.error);
    }
    const parsed = parseSyncPage(response.value, options);
    if (parsed.isErr()) return err(parsed.error);
    for (const account of parsed.value.accounts) accounts.set(account.providerAccountId, account);
    added.push(...parsed.value.added);
    modified.push(...parsed.value.modified);
    removed.push(...parsed.value.removed);
    nextCursor = parsed.value.nextCursor;
    if (!parsed.value.hasMore) {
      return ok({
        accounts: [...accounts.values()],
        added,
        modified,
        removed,
        nextCursor,
      });
    }
    cursor = nextCursor;
  }

  if (!nextCursor) return err(new ProviderSyncError());
  return ok({
    accounts: [...accounts.values()],
    added,
    modified,
    removed,
    nextCursor,
  });
}

type SyncPage = PlaidSyncSnapshot & { hasMore: boolean };

function parseSyncPage(
  body: unknown,
  options: { since?: string; includePending?: boolean },
): Result<SyncPage, ProviderSyncError> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return err(new ProviderSyncError());
  const record = body as Record<string, unknown>;
  const accounts = parseAccounts(record.accounts);
  if (accounts.isErr()) return err(accounts.error);
  const nextCursor = typeof record.next_cursor === "string" ? record.next_cursor.trim() : "";
  if (!isCursor(nextCursor)) return err(new ProviderSyncError());
  const added = parseTransactions(record.added, options);
  if (added.isErr()) return err(added.error);
  const modified = parseTransactions(record.modified, { includePending: options.includePending });
  if (modified.isErr()) return err(modified.error);
  const removed = parseRemoved(record.removed);
  if (removed.isErr()) return err(removed.error);
  return ok({
    accounts: accounts.value,
    added: added.value,
    modified: modified.value,
    removed: removed.value,
    nextCursor,
    hasMore: record.has_more === true,
  });
}

function parseTransactions(
  value: unknown,
  options: { since?: string; includePending?: boolean },
): Result<ProviderTransaction[], ProviderSyncError> {
  if (value == null) return ok([]);
  if (!Array.isArray(value)) return err(new ProviderSyncError());
  const rows: ProviderTransaction[] = [];
  for (const entry of value) {
    const transaction = parseTransaction(entry);
    if (transaction.isErr()) return err(transaction.error);
    if (transaction.value.pending && !options.includePending) continue;
    if (options.since && transaction.value.occurredOn < options.since) continue;
    rows.push(transaction.value);
  }
  return ok(rows);
}

function parseTransaction(entry: unknown): Result<ProviderTransaction, ProviderSyncError> {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return err(new ProviderSyncError());
  const record = entry as Record<string, unknown>;
  const providerTransactionId = typeof record.transaction_id === "string" ? record.transaction_id.trim() : "";
  const providerAccountId = typeof record.account_id === "string" ? record.account_id.trim() : "";
  if (!isStableId(providerTransactionId) || !isStableId(providerAccountId)) return err(new ProviderSyncError());
  const occurredOn = isoDate(record.date) ?? isoDate(record.authorized_date);
  if (!occurredOn) return err(new ProviderSyncError());
  if (typeof record.amount !== "number") return err(new ProviderSyncError());
  const amountCents = plaidAmountToCents(record.amount);
  if (amountCents.isErr()) return err(amountCents.error);
  const authorizedOn = isoDate(record.authorized_date);
  const pendingTransactionId =
    typeof record.pending_transaction_id === "string" ? record.pending_transaction_id.trim() : "";
  return ok({
    providerTransactionId,
    providerAccountId,
    occurredOn,
    payee: payeeFrom(record.merchant_name, record.name),
    amountCents: amountCents.value,
    pending: record.pending === true,
    ...(authorizedOn ? { authorizedOn } : {}),
    ...(isStableId(pendingTransactionId) && pendingTransactionId !== providerTransactionId ? { pendingTransactionId } : {}),
  });
}

function parseRemoved(value: unknown): Result<string[], ProviderSyncError> {
  if (value == null) return ok([]);
  if (!Array.isArray(value)) return err(new ProviderSyncError());
  const ids: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return err(new ProviderSyncError());
    const id = (entry as Record<string, unknown>).transaction_id;
    if (typeof id !== "string" || !isStableId(id.trim())) return err(new ProviderSyncError());
    ids.push(id.trim());
  }
  return ok(ids);
}

function parseAccounts(value: unknown): Result<ProviderAccount[], ProviderSyncError> {
  if (!Array.isArray(value)) return err(new ProviderSyncError());
  const accounts: ProviderAccount[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const account = parseAccount(entry);
    if (account.isErr()) return err(account.error);
    if (seen.has(account.value.providerAccountId)) return err(new ProviderSyncError());
    seen.add(account.value.providerAccountId);
    accounts.push(account.value);
  }
  return ok(accounts);
}

function parseAccount(entry: unknown): Result<ProviderAccount, ProviderSyncError> {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return err(new ProviderSyncError());
  const record = entry as Record<string, unknown>;
  const providerAccountId = typeof record.account_id === "string" ? record.account_id.trim() : "";
  if (!isStableId(providerAccountId)) return err(new ProviderSyncError());
  const name = accountName(record.name, record.official_name);
  if (!name) return err(new ProviderSyncError());
  const type = mapAccountType(record.type, record.subtype);
  const balances = record.balances;
  if (!balances || typeof balances !== "object" || Array.isArray(balances)) return err(new ProviderSyncError());
  const balanceRecord = balances as Record<string, unknown>;
  const currency = normalizeCurrency(balanceRecord.iso_currency_code ?? record.iso_currency_code);
  if (!currency) return err(new ProviderSyncError());
  const current = typeof balanceRecord.current === "number" ? balanceRecord.current : null;
  const available = typeof balanceRecord.available === "number" ? balanceRecord.available : null;
  const balanceCents = plaidBalanceToCents(type, current, available);
  if (balanceCents.isErr()) return err(balanceCents.error);
  return ok({
    providerAccountId,
    name,
    type,
    currency,
    balanceCents: balanceCents.value,
  });
}

function plaidBalanceToCents(
  type: ProviderAccountType,
  current: number | null,
  available: number | null,
): Result<Cents, ProviderSyncError> {
  const raw = current ?? available ?? 0;
  const cents = finiteDollarsToCents(raw);
  if (cents.isErr()) return err(cents.error);
  if (type !== "credit") return ok(cents.value);
  const owed = -cents.value;
  if (!Number.isSafeInteger(owed)) {
    return err(new ProviderSyncError("The bank sent an amount Dollas cannot store. Try syncing again."));
  }
  return ok(owed);
}

function mapAccountType(type: unknown, subtype: unknown): ProviderAccountType {
  const kind = typeof type === "string" ? type : "";
  const detail = typeof subtype === "string" ? subtype : "";
  if (kind === "credit" || kind === "loan") return "credit";
  if (detail === "savings" || detail === "money market" || detail === "cd" || detail === "hsa") return "savings";
  if (detail === "cash management") return "cash";
  if (kind === "depository") return "checking";
  return "other";
}

function accountName(name: unknown, official: unknown): string | null {
  const raw = typeof name === "string" && name.trim() ? name : typeof official === "string" ? official : "";
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length < 1) return null;
  return cleaned.slice(0, 200);
}

function payeeFrom(merchant: unknown, name: unknown): string {
  const raw = typeof merchant === "string" && merchant.trim() ? merchant : typeof name === "string" ? name : "";
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return "Bank transaction";
  return cleaned.slice(0, 200);
}

function finiteDollarsToCents(amount: number): Result<number, ProviderSyncError> {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return err(new ProviderSyncError("The bank sent an amount Dollas cannot store. Try syncing again."));
  }
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > 10_000_000_000) {
    return err(new ProviderSyncError("The bank sent an amount Dollas cannot store. Try syncing again."));
  }
  return ok(cents);
}

class PlaidStatusError extends ProviderError {
  readonly plaidCode: string;

  constructor(message: string, code: string, plaidCode: string) {
    super(message, code);
    this.plaidCode = plaidCode;
  }
}

async function postPlaid(
  host: string,
  path: string,
  fetchImpl: FetchLike,
  body: Record<string, unknown>,
): Promise<Result<unknown, ProviderError>> {
  let response: Response;
  try {
    response = await fetchImpl(`${host}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "plaid-version": PLAID_VERSION,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return err(new ProviderNetworkError());
  }
  if (response.status >= 300 && response.status < 400) return err(new ProviderNetworkError());
  const text = await readLimited(response, BODY_LIMIT);
  if (text == null) return err(response.ok ? new ProviderSyncError() : new ProviderNetworkError());
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return err(response.ok ? new ProviderSyncError() : new ProviderNetworkError());
  }
  if (!response.ok) return err(mapPlaidError(response.status, parsed));
  return ok(parsed);
}

function mapPlaidError(status: number, body: unknown): ProviderError {
  const code = errorCode(body);
  if (code === "INVALID_PUBLIC_TOKEN" || code === "INVALID_LINK_TOKEN") {
    return new InvalidSetupTokenError("That Plaid link expired. Start the link again.");
  }
  if (code === "INVALID_API_KEYS") {
    return new PlaidStatusError(
      "Plaid rejected the API keys. Check PLAID_CLIENT_ID, PLAID_SECRET, and PLAID_ENV.",
      "provider_auth",
      code,
    );
  }
  if (code === "INVALID_CURSOR" || code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") {
    return new PlaidStatusError("The bank sent accounts Dollas could not read. Try syncing again.", "provider_sync", code);
  }
  if (code === "PRODUCT_NOT_READY") {
    return new ProviderSyncError("The bank is still preparing transactions. Try syncing again.");
  }
  if (
    code === "ITEM_LOGIN_REQUIRED" ||
    code === "INVALID_ACCESS_TOKEN" ||
    code === "ACCESS_NOT_GRANTED" ||
    status === 401 ||
    status === 403
  ) {
    return new PlaidStatusError(
      "The bank rejected this connection. Disconnect it and link Plaid again.",
      "provider_auth",
      code,
    );
  }
  if (status === 429 || code === "RATE_LIMIT_EXCEEDED" || status >= 500) {
    return new ProviderNetworkError();
  }
  return new ProviderSyncError();
}

function errorCode(body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const code = (body as Record<string, unknown>).error_code;
  return typeof code === "string" ? code : "";
}

function recordField(body: unknown, key: string): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  return (body as Record<string, unknown>)[key];
}

function readToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const token = value.trim();
  if (token.length < 8 || token.length > 2_048 || /[\s\u0000-\u001f\u007f]/.test(token)) return null;
  return token;
}

function isCursor(value: string): boolean {
  return value.length >= 1 && value.length <= 8_192 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isoDate(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return value;
}

function normalizeCurrency(value: unknown): string | null {
  const currency = typeof value === "string" && value.trim() ? value.trim().toUpperCase() : "USD";
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function isStableId(value: string): boolean {
  return value.length >= 1 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isCredential(value: string): boolean {
  return value.length >= 1 && value.length <= 200 && !/[\s\u0000-\u001f\u007f]/.test(value);
}

function clampDays(value: number | undefined): number {
  if (value == null || !Number.isInteger(value)) return 90;
  return Math.min(730, Math.max(1, value));
}

function readRedirectUri(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "https:" || (url.protocol === "http:" && local)) return url.toString();
  return null;
}

async function readLimited(response: Response, max: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    try {
      const text = await response.text();
      return text.length > max ? null : text;
    } catch {
      return null;
    }
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}
