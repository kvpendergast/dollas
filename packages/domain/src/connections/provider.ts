import { err, ok, type Result } from "neverthrow";
import { ProviderError } from "../errors";
import { isCents, type Cents } from "../money/cents";

const PROVIDER_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CREDENTIAL_KEY = /^(password|passwd|passcode|pin|username|user|user_name)$/i;

/**
 * What the household pastes or what a provider client flow returns.
 * There is no username or password field. SimpleFIN uses a one-time setup
 * token. Plaid exchanges a public token from Link.
 */
export type ProviderSetup = {
  token: string;
};

/** Opaque credential returned by exchange. Encrypt this before it is stored. */
export type ProviderAccess = {
  accessToken: string;
};

export type ProviderAccountType = "checking" | "savings" | "credit" | "cash" | "other";

export type ProviderAccount = {
  providerAccountId: string;
  name: string;
  type: ProviderAccountType;
  currency: string;
  balanceCents?: Cents;
};

/**
 * A provider transaction. `providerTransactionId` is the stable identity a
 * later sync writes into the ledger import fingerprint, so a repeat pull and
 * a CSV import of the same household stay idempotent.
 */
export type ProviderTransaction = {
  providerTransactionId: string;
  providerAccountId: string;
  occurredOn: string;
  payee: string;
  amountCents: Cents;
  pending: boolean;
  /**
   * When the charge was authorized, if the provider says (Plaid
   * `authorized_date`, SimpleFIN `transacted_at`). Used only to widen the date
   * window when matching a CSV or manual copy; the book date stays `occurredOn`.
   */
  authorizedOn?: string;
  /**
   * Plaid `pending_transaction_id`: the pending row this posted row replaces.
   * Pending rows are not booked, but if the pending id is somehow known the
   * posted row takes over that transaction instead of adding a second one.
   */
  pendingTransactionId?: string;
};

export type TransactionQuery = {
  /** Inclusive civil date. Earlier transactions are left out. */
  since?: string;
  providerAccountId?: string;
  /**
   * When true, include transactions the provider still marks pending.
   * Omitted or false matches SimpleFIN's default and leaves those rows out.
   */
  includePending?: boolean;
};

export interface BankProvider {
  readonly id: string;
  readonly label: string;
  exchange(setup: ProviderSetup): Promise<Result<ProviderAccess, ProviderError>>;
  listAccounts(access: ProviderAccess): Promise<Result<readonly ProviderAccount[], ProviderError>>;
  fetchTransactions(
    access: ProviderAccess,
    query: TransactionQuery,
  ): Promise<Result<readonly ProviderTransaction[], ProviderError>>;
  disconnect(access: ProviderAccess): Promise<Result<void, ProviderError>>;
}

export type ProviderSummary = {
  id: string;
  label: string;
};

export type ProviderRegistry = {
  register(provider: BankProvider): Result<void, ProviderError>;
  select(providerId: string): Result<BankProvider, ProviderError>;
  list(): readonly ProviderSummary[];
};

export function createProviderRegistry(): ProviderRegistry {
  const providers = new Map<string, BankProvider>();
  return {
    register(provider) {
      if (!PROVIDER_ID.test(provider.id)) {
        return err(new ProviderError("That provider id is not usable."));
      }
      if (providers.has(provider.id)) {
        return err(new ProviderError(`A provider is already registered as ${provider.id}.`));
      }
      providers.set(provider.id, provider);
      return ok(undefined);
    },
    select(providerId) {
      if (!PROVIDER_ID.test(providerId)) {
        return err(new ProviderError("That provider id is not usable."));
      }
      const provider = providers.get(providerId);
      if (!provider) {
        return err(new ProviderError(`No bank provider is registered for ${providerId}.`));
      }
      return ok(provider);
    },
    list() {
      return [...providers.values()].map((provider) => ({ id: provider.id, label: provider.label }));
    },
  };
}

export function readProviderSetup(input: unknown): Result<ProviderSetup, ProviderError> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return err(new ProviderError("A bank connection needs a provider token."));
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (CREDENTIAL_KEY.test(key) || /password/i.test(key)) {
      return err(new ProviderError("Bank usernames and passwords are not accepted."));
    }
  }
  const token = record.token;
  if (typeof token !== "string") {
    return err(new ProviderError("Paste a provider token. A bank password is not a connection."));
  }
  const trimmed = token.trim();
  if (trimmed.length === 0 || trimmed.length > 4_096 || trimmed.includes("\0")) {
    return err(new ProviderError("That provider token cannot be used."));
  }
  if (looksLikeBankCredentials(trimmed) || jsonCarriesCredentials(trimmed)) {
    return err(new ProviderError("That value is not a provider token. Bank passwords are not stored."));
  }
  return ok({ token: trimmed });
}

/**
 * Ledger identity for a later bank sync. The transaction table already
 * dedupes on (household, import fingerprint). CSV fingerprints are a content
 * hash plus a row index; bank fingerprints start with `bank:` so the two
 * sources do not collide and a second sync adds nothing.
 */
export function providerTransactionFingerprint(
  providerId: string,
  providerTransactionId: string,
): Result<string, ProviderError> {
  if (!PROVIDER_ID.test(providerId) || !isStableId(providerTransactionId)) {
    return err(new ProviderError("A synced transaction needs a provider and a stable transaction id."));
  }
  return ok(`bank:${encodeURIComponent(providerId)}:${encodeURIComponent(providerTransactionId)}`);
}

export const FAKE_BANK_PROVIDER_ID = "fake";

export type FakeBankProvider = BankProvider & {
  issuedAccessTokens(): readonly string[];
  revokedAccessTokens(): readonly string[];
};

const DEFAULT_ACCOUNTS: readonly ProviderAccount[] = [
  {
    providerAccountId: "checking",
    name: "Checking",
    type: "checking",
    currency: "USD",
    balanceCents: 245_000,
  },
];

const DEFAULT_TRANSACTIONS: readonly ProviderTransaction[] = [
  {
    providerTransactionId: "txn-rent",
    providerAccountId: "checking",
    occurredOn: "2026-03-02",
    payee: "Rent",
    amountCents: -180_000,
    pending: false,
  },
];

/** In-memory provider for tests and local seed. Not a live bank. */
export function createFakeBankProvider(options?: {
  accounts?: readonly ProviderAccount[];
  transactions?: readonly ProviderTransaction[];
  failExchange?: boolean;
  failDisconnect?: boolean;
  newAccessToken?: () => string | null;
}): FakeBankProvider {
  const accounts = options?.accounts ?? DEFAULT_ACCOUNTS;
  const transactions = options?.transactions ?? DEFAULT_TRANSACTIONS;
  const live = new Set<string>();
  const issued: string[] = [];
  const revoked: string[] = [];
  const newAccessToken = options?.newAccessToken ?? randomAccessToken;

  return {
    id: FAKE_BANK_PROVIDER_ID,
    label: "Demo bank",
    issuedAccessTokens: () => issued.slice(),
    revokedAccessTokens: () => revoked.slice(),
    async exchange(setup) {
      const parsed = readProviderSetup(setup);
      if (parsed.isErr()) return err(parsed.error);
      if (options?.failExchange) return err(new ProviderError("That setup token was rejected."));
      const accessToken = newAccessToken();
      if (!accessToken) return err(new ProviderError("Could not exchange that setup token."));
      issued.push(accessToken);
      live.add(accessToken);
      return ok({ accessToken });
    },
    async listAccounts(access) {
      if (!live.has(access.accessToken)) return err(inactive());
      return ok(accounts);
    },
    async fetchTransactions(access, query) {
      if (!live.has(access.accessToken)) return err(inactive());
      const rows = transactions.filter((row) => {
        if (query.providerAccountId && row.providerAccountId !== query.providerAccountId) return false;
        if (query.since && row.occurredOn < query.since) return false;
        if (row.pending && !query.includePending) return false;
        return true;
      });
      for (const row of rows) {
        if (!isCents(row.amountCents) || !ISO_DATE.test(row.occurredOn) || !isStableId(row.providerTransactionId)) {
          return err(new ProviderError("That provider returned a transaction Dollas cannot store."));
        }
      }
      return ok(rows);
    },
    async disconnect(access) {
      revoked.push(access.accessToken);
      if (options?.failDisconnect) return err(new ProviderError("The provider could not be reached."));
      live.delete(access.accessToken);
      return ok(undefined);
    },
  };
}

function inactive(): ProviderError {
  return new ProviderError("That bank connection is no longer active.");
}

function randomAccessToken(): string | null {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!crypto?.randomUUID) return null;
  return `fake.${crypto.randomUUID()}`;
}

function looksLikeBankCredentials(token: string): boolean {
  return /(?:^|[?&#\s])(?:user(?:name)?|pass(?:word|wd)?|pin)=/i.test(token);
}

function jsonCarriesCredentials(token: string): boolean {
  if (!token.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(token) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return Object.keys(parsed as Record<string, unknown>).some(
      (key) => CREDENTIAL_KEY.test(key) || /password/i.test(key),
    );
  } catch {
    return false;
  }
}

function isStableId(value: string): boolean {
  return value.length >= 1 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}
