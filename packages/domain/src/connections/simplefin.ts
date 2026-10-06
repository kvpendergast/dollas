import { err, ok, type Result } from "neverthrow";
import {
  InvalidSetupTokenError,
  ProviderAuthError,
  ProviderClaimError,
  ProviderError,
  ProviderNetworkError,
  ProviderSyncError,
  UsedSetupTokenError,
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

export const SIMPLEFIN_PROVIDER_ID = "simplefin";

const CLAIM_BODY_LIMIT = 8_192;
const ACCOUNTS_BODY_LIMIT = 2_000_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type SimpleFinBooks = {
  accounts: ProviderAccount[];
  transactions: ProviderTransaction[];
  /** Count of bridge error strings. The strings themselves are not kept. */
  noticeCount: number;
};

export type SimpleFinProvider = BankProvider & {
  readBooks(access: ProviderAccess, query: TransactionQuery): Promise<Result<SimpleFinBooks, ProviderError>>;
};

export type SimpleFinProviderOptions = {
  /**
   * Local mock bridges use http://127.0.0.1. Production leaves this off so a
   * setup token cannot send the server at a loopback or private host.
   */
  allowLoopback?: boolean;
  fetch?: typeof fetch;
};

type FetchLike = typeof fetch;

/**
 * SimpleFIN Bridge adapter.
 * A setup token is a base64 claim URL. Claiming is one POST. The response
 * body is the access URL, which is the only credential we keep, and only
 * after the caller encrypts it. Disconnect forgets it locally: the protocol
 * has no revoke call, and this adapter does not send the access URL again
 * on the way out.
 */
export function createSimpleFinProvider(options?: SimpleFinProviderOptions): SimpleFinProvider {
  const allowLoopback = options?.allowLoopback === true;
  const fetchImpl: FetchLike = options?.fetch ?? fetch;

  return {
    id: SIMPLEFIN_PROVIDER_ID,
    label: "SimpleFIN",
    async exchange(setup) {
      const parsed = readProviderSetup(setup);
      if (parsed.isErr()) return err(parsed.error);
      const claimUrl = claimUrlFromToken(parsed.value.token, allowLoopback);
      if (!claimUrl) return err(new InvalidSetupTokenError());
      return claimAccess(claimUrl, allowLoopback, fetchImpl);
    },
    async listAccounts(access) {
      const books = await fetchBooks(access.accessToken, {}, allowLoopback, fetchImpl);
      if (books.isErr()) return err(books.error);
      return ok(books.value.accounts);
    },
    async fetchTransactions(access, query) {
      const books = await fetchBooks(access.accessToken, query, allowLoopback, fetchImpl);
      if (books.isErr()) return err(books.error);
      return ok(books.value.transactions);
    },
    async disconnect() {
      return ok(undefined);
    },
    readBooks(access, query) {
      return fetchBooks(access.accessToken, query, allowLoopback, fetchImpl);
    },
  };
}

/** Integer cents from a SimpleFIN decimal string. Extra non-zero digits are refused. */
export function providerDecimalToCents(raw: string): Result<Cents, ProviderSyncError> {
  const trimmed = raw.trim().replace(/[$,\s]/g, "");
  const match = trimmed.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) return err(new ProviderSyncError("The bank sent an amount Dollas cannot store. Try syncing again."));
  const fraction = match[3] ?? "";
  if ([...fraction.slice(2)].some((digit) => digit !== "0")) {
    return err(new ProviderSyncError("The bank sent an amount Dollas cannot store. Try syncing again."));
  }
  const dollars = Number(match[2]);
  if (!Number.isSafeInteger(dollars) || dollars > 100_000_000) {
    return err(new ProviderSyncError("The bank sent an amount Dollas cannot store. Try syncing again."));
  }
  const centsPart = Number(fraction.slice(0, 2).padEnd(2, "0"));
  const sign = match[1] === "-" ? -1 : 1;
  const cents = sign * (dollars * 100 + centsPart);
  if (!Number.isSafeInteger(cents)) {
    return err(new ProviderSyncError("The bank sent an amount Dollas cannot store. Try syncing again."));
  }
  return ok(cents);
}

async function claimAccess(
  claimUrl: URL,
  allowLoopback: boolean,
  fetchImpl: FetchLike,
): Promise<Result<ProviderAccess, ProviderError>> {
  let response: Response;
  try {
    response = await fetchImpl(claimUrl, {
      method: "POST",
      redirect: "manual",
      headers: { accept: "text/plain" },
    });
  } catch {
    return err(new ProviderClaimError());
  }
  if (response.status >= 300 && response.status < 400) return err(new ProviderClaimError());
  const body = await readLimited(response, CLAIM_BODY_LIMIT);
  if (body == null) return err(new ProviderClaimError());
  if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404) {
    if (looksUsed(body)) return err(new UsedSetupTokenError());
    return err(new InvalidSetupTokenError());
  }
  if (!response.ok) return err(new ProviderClaimError());
  const accessUrl = body.trim();
  if (!parseAccessUrl(accessUrl, allowLoopback)) return err(new ProviderClaimError());
  return ok({ accessToken: accessUrl });
}

async function fetchBooks(
  accessToken: string,
  query: TransactionQuery,
  allowLoopback: boolean,
  fetchImpl: FetchLike,
): Promise<Result<SimpleFinBooks, ProviderError>> {
  const accessUrl = parseAccessUrl(accessToken, allowLoopback);
  if (!accessUrl) return err(new ProviderAuthError());
  const endpoint = accountsEndpoint(accessUrl, query);
  if (endpoint.isErr()) return err(endpoint.error);
  const authorization = basicAuthorization(accessUrl);
  if (!authorization) return err(new ProviderAuthError());
  const requestUrl = new URL(endpoint.value.href);
  requestUrl.username = "";
  requestUrl.password = "";

  let response: Response;
  try {
    response = await fetchImpl(requestUrl, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json", authorization },
    });
  } catch {
    return err(new ProviderNetworkError());
  }
  if (response.status >= 300 && response.status < 400) return err(new ProviderNetworkError());
  if (response.status === 401 || response.status === 403) return err(new ProviderAuthError());
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    return err(new ProviderNetworkError());
  }
  if (!response.ok) return err(new ProviderSyncError());
  const body = await readLimited(response, ACCOUNTS_BODY_LIMIT);
  if (body == null) return err(new ProviderSyncError());
  return parseBooks(body, query);
}

function parseBooks(body: string, query: TransactionQuery): Result<SimpleFinBooks, ProviderError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return err(new ProviderSyncError());
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return err(new ProviderSyncError());
  const record = parsed as Record<string, unknown>;
  const noticeCount = Array.isArray(record.errors) ? record.errors.length : 0;
  if (!Array.isArray(record.accounts)) return err(new ProviderSyncError());

  const accounts: ProviderAccount[] = [];
  const transactions: ProviderTransaction[] = [];
  const seenAccounts = new Set<string>();
  for (const entry of record.accounts) {
    const account = parseAccount(entry);
    if (account.isErr()) return err(account.error);
    if (seenAccounts.has(account.value.account.providerAccountId)) return err(new ProviderSyncError());
    seenAccounts.add(account.value.account.providerAccountId);
    accounts.push(account.value.account);
    for (const transaction of account.value.transactions) {
      if (transaction.pending && !query.includePending) continue;
      if (query.since && transaction.occurredOn < query.since) continue;
      if (query.providerAccountId && transaction.providerAccountId !== query.providerAccountId) continue;
      transactions.push(transaction);
    }
  }
  return ok({ accounts, transactions, noticeCount });
}

function parseAccount(entry: unknown): Result<{ account: ProviderAccount; transactions: ProviderTransaction[] }, ProviderSyncError> {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return err(new ProviderSyncError());
  const record = entry as Record<string, unknown>;
  const providerAccountId = typeof record.id === "string" ? record.id.trim() : "";
  if (!isStableId(providerAccountId)) return err(new ProviderSyncError());
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (name.length < 1 || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name)) return err(new ProviderSyncError());
  const currency = normalizeCurrency(record.currency);
  if (!currency) return err(new ProviderSyncError());
  if (typeof record.balance !== "string") return err(new ProviderSyncError());
  const balanceCents = providerDecimalToCents(record.balance);
  if (balanceCents.isErr()) return err(balanceCents.error);
  const transactions: ProviderTransaction[] = [];
  const rows = record.transactions;
  if (rows != null) {
    if (!Array.isArray(rows)) return err(new ProviderSyncError());
    for (const row of rows) {
      const transaction = parseTransaction(row, providerAccountId);
      if (transaction.isErr()) return err(transaction.error);
      transactions.push(transaction.value);
    }
  }
  return ok({
    account: {
      providerAccountId,
      name,
      type: inferAccountType(name),
      currency,
      balanceCents: balanceCents.value,
    },
    transactions,
  });
}

function parseTransaction(
  entry: unknown,
  providerAccountId: string,
): Result<ProviderTransaction, ProviderSyncError> {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return err(new ProviderSyncError());
  const record = entry as Record<string, unknown>;
  const providerTransactionId = typeof record.id === "string" ? record.id.trim() : "";
  if (!isStableId(providerTransactionId)) return err(new ProviderSyncError());
  const occurredOn = unixSecondsToIsoDate(record.posted);
  if (!occurredOn) return err(new ProviderSyncError());
  if (typeof record.amount !== "string") return err(new ProviderSyncError());
  const amountCents = providerDecimalToCents(record.amount);
  if (amountCents.isErr()) return err(amountCents.error);
  const description = typeof record.description === "string" ? record.description : "";
  return ok({
    providerTransactionId,
    providerAccountId,
    occurredOn,
    payee: payeeFrom(description),
    amountCents: amountCents.value,
    pending: record.pending === true,
  });
}

function accountsEndpoint(accessUrl: URL, query: TransactionQuery): Result<URL, ProviderSyncError> {
  const url = new URL(accessUrl.href);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path}/accounts`;
  url.search = "";
  url.hash = "";
  if (query.since) {
    if (!ISO_DATE.test(query.since)) return err(new ProviderSyncError("Use a start date like 2026-01-01."));
    const unix = isoDateToUnix(query.since);
    if (unix == null) return err(new ProviderSyncError("Use a start date like 2026-01-01."));
    url.searchParams.set("start-date", String(unix));
  }
  if (query.includePending) url.searchParams.set("pending", "1");
  if (query.providerAccountId) {
    if (!isStableId(query.providerAccountId)) return err(new ProviderSyncError());
    url.searchParams.set("account", query.providerAccountId);
  }
  return ok(url);
}

function claimUrlFromToken(token: string, allowLoopback: boolean): URL | null {
  const decoded = decodeBase64Utf8(token.replace(/\s+/g, ""));
  if (!decoded) return null;
  return parseClaimUrl(decoded, allowLoopback);
}

function parseClaimUrl(raw: string, allowLoopback: boolean): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  if (url.protocol === "https:") {
    if (isBlockedHost(url.hostname, allowLoopback)) return null;
    return url;
  }
  if (allowLoopback && url.protocol === "http:" && isLoopbackHost(url.hostname)) return url;
  return null;
}

function parseAccessUrl(raw: string, allowLoopback: boolean): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!url.username || !url.password || url.hash) return null;
  if (url.protocol === "https:") {
    if (isBlockedHost(url.hostname, allowLoopback)) return null;
    return url;
  }
  if (allowLoopback && url.protocol === "http:" && isLoopbackHost(url.hostname)) return url;
  return null;
}

function basicAuthorization(accessUrl: URL): string | null {
  let username: string;
  let password: string;
  try {
    username = decodeURIComponent(accessUrl.username);
    password = decodeURIComponent(accessUrl.password);
  } catch {
    return null;
  }
  if (!username || !password) return null;
  const bytes = utf8(username + ":" + password);
  const encoded = encodeBase64(bytes);
  if (!encoded) return null;
  return `Basic ${encoded}`;
}

function inferAccountType(name: string): ProviderAccountType {
  const normalized = name.toLowerCase();
  if (/(credit|visa|mastercard|amex|discover|\bcard\b)/.test(normalized)) return "credit";
  if (/saving/.test(normalized)) return "savings";
  if (/\bcash\b|wallet/.test(normalized)) return "cash";
  if (/check|chequing|debit/.test(normalized)) return "checking";
  return "other";
}

function payeeFrom(description: string): string {
  const cleaned = description.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return "Bank transaction";
  return cleaned.slice(0, 200);
}

function normalizeCurrency(value: unknown): string | null {
  const currency = typeof value === "string" && value.trim() ? value.trim().toUpperCase() : "USD";
  return /^[A-Z]{3}$/.test(currency) ? currency : null;
}

function looksUsed(body: string): boolean {
  return /already|claimed|used/i.test(body.slice(0, 500));
}

function isoDateToUnix(iso: string): number | null {
  if (!ISO_DATE.test(iso)) return null;
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return Math.floor(date.getTime() / 1000);
}

function unixSecondsToIsoDate(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function isStableId(value: string): boolean {
  return value.length >= 1 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

function isBlockedHost(hostname: string, allowLoopback: boolean): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (isLoopbackHost(host)) return !allowLoopback;
  if (host === "0.0.0.0" || host === "::" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  const private172 = host.match(/^172\.(\d+)\./);
  if (private172) {
    const second = Number(private172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  if (host.includes(":")) {
    if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
  }
  return false;
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

function decodeBase64Utf8(token: string): string | null {
  if (token.length < 8 || token.length > 4_096) return null;
  const normalized = token.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
  const remainder = normalized.length % 4;
  const padded = remainder === 0 ? normalized : normalized + "=".repeat(4 - remainder);
  const decode = (globalThis as { atob?: (value: string) => string }).atob;
  if (!decode) return null;
  let binary: string;
  try {
    binary = decode(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const again = encodeBase64(bytes);
  if (!again || again.replace(/=+$/, "") !== padded.replace(/=+$/, "")) return null;
  const text = new TextDecoder().decode(bytes);
  if (!text || text.includes("\0")) return null;
  return text;
}

function encodeBase64(bytes: Uint8Array): string | null {
  const encode = (globalThis as { btoa?: (value: string) => string }).btoa;
  if (!encode) return null;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return encode(binary);
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
