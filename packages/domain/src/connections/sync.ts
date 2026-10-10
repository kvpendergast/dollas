import { err, ok, type Result } from "neverthrow";
import { ProviderSyncError } from "../errors";
import type { AccountType } from "../accounts/ledger";
import { isCents, type Cents } from "../money/cents";
import { matchingPayeeRule, type PayeeCategoryRule } from "../rules/payee-category";
import { pairCharges } from "./match";
import { PLAID_PROVIDER_ID } from "./plaid";
import {
  providerTransactionFingerprint,
  type ProviderAccount,
  type ProviderAccountType,
  type ProviderTransaction,
} from "./provider";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type SyncLedgerAccount = {
  id: string;
  householdId: string;
  name: string;
  type: AccountType;
  archivedAt: string | null;
};

export type SyncAccountLink = {
  providerAccountId: string;
  ledgerAccountId: string;
};

export type PlannedBankAccount =
  | {
      kind: "create";
      providerAccountId: string;
      name: string;
      type: AccountType;
      currency: string;
      balanceCents: Cents;
      openingBalanceCents: Cents;
    }
  | {
      kind: "link" | "update";
      providerAccountId: string;
      ledgerAccountId: string;
      currency: string;
      balanceCents: Cents;
    };

export type PlannedBankTransaction = {
  providerAccountId: string;
  providerTransactionId: string;
  occurredOn: string;
  payee: string;
  amountCents: Cents;
  categoryId: string | null;
};

/** The provider's identity for one charge. Unique per household in the books. */
export type BankIdentity = {
  providerId: string;
  providerAccountId: string;
  providerTransactionId: string;
};

/**
 * A book row the planner needs to see: every row that already carries a bank
 * identity (or a pre-PEN-203 `bank:` import fingerprint), plus CSV and manual
 * rows that could be the same charge as an incoming bank row. Soft-deleted
 * rows are included on purpose: they stay deleted and block a re-insert.
 */
export type SyncBookTransaction = {
  id: string;
  householdId: string;
  accountId: string;
  occurredOn: string;
  payee: string;
  amountCents: Cents;
  deletedAt: string | null;
  createdAt: string;
  bank: BankIdentity | null;
  importFingerprint: string | null;
  /** The row existed (CSV or manual) before a sync linked the bank charge to it. */
  matched: boolean;
};

/** Record the bank identity on an existing CSV or manual row instead of inserting a second copy. */
export type PlannedBankLink = {
  transactionId: string;
  providerAccountId: string;
  providerTransactionId: string;
  bankOccurredOn: string;
  bankPayee: string;
  /** Linking a soft-deleted row keeps it deleted; the identity stops the charge coming back. */
  deleted: boolean;
};

/**
 * Change a row the bank already backs. For a row sync created, the bank's date,
 * payee, and amount win. For a matched row, the member's date and payee stay;
 * only the amount and the bank snapshot change. A deleted row only gets its
 * identity moved (pending to posted) and stays deleted.
 */
export type PlannedBankUpdate = {
  transactionId: string;
  providerAccountId: string;
  providerTransactionId: string;
  occurredOn: string;
  payee: string;
  amountCents: Cents;
  matched: boolean;
  deleted: boolean;
  /** The row still had a pre-PEN-203 `bank:` import fingerprint; clear it once the identity columns are set. */
  clearLegacyFingerprint: boolean;
};

/** The bank withdrew a charge. A row sync created is hidden; a matched row is unlinked and kept, since the member's CSV or entry still backs it. */
export type PlannedBankRemoval = {
  transactionId: string;
  matched: boolean;
};

export type BankSyncPlan = {
  accounts: PlannedBankAccount[];
  transactions: PlannedBankTransaction[];
  links: PlannedBankLink[];
  updates: PlannedBankUpdate[];
};

type KnownIndex = {
  find(providerAccountId: string, providerTransactionId: string): SyncBookTransaction | null;
};

function indexKnown(providerId: string, householdId: string, books: readonly SyncBookTransaction[]): KnownIndex {
  const byIdentity = new Map<string, SyncBookTransaction>();
  const byLegacy = new Map<string, SyncBookTransaction>();
  if (householdId.trim().length > 0) {
    for (const row of books) {
      if (row.householdId !== householdId) continue;
      if (row.bank && row.bank.providerId === providerId) {
        byIdentity.set(identityKey(row.bank.providerAccountId, row.bank.providerTransactionId), row);
      }
      if (row.importFingerprint?.startsWith("bank:")) byLegacy.set(row.importFingerprint, row);
    }
  }
  return {
    find(providerAccountId, providerTransactionId) {
      const found = byIdentity.get(identityKey(providerAccountId, providerTransactionId));
      if (found) return found;
      const legacy = providerTransactionFingerprint(providerId, providerTransactionId);
      return legacy.isOk() ? (byLegacy.get(legacy.value) ?? null) : null;
    },
  };
}

function identityKey(providerAccountId: string, providerTransactionId: string): string {
  return `${providerAccountId}\u0000${providerTransactionId}`;
}

function isCandidate(row: SyncBookTransaction, householdId: string): boolean {
  return row.householdId === householdId && row.bank == null && !row.importFingerprint?.startsWith("bank:");
}

/**
 * Map a provider snapshot onto the household books.
 * - Identity: (provider, provider account, provider transaction id). A row the
 *   books already hold under that identity is skipped, deleted or not, so a
 *   re-sync is a no-op and a deleted charge stays deleted.
 * - Pending rows are not booked. A posted row whose `pendingTransactionId` is
 *   already known takes over that row instead of adding one.
 * - New rows on an account that already had transactions are matched against
 *   CSV and manual rows with {@link pairCharges}; a pair links instead of inserting.
 * - An account that was linked before is updated in place; a new one is
 *   created, or matched to a single active ledger account with the same name.
 */
export function planBankSync(input: {
  providerId: string;
  householdId: string;
  accounts: readonly ProviderAccount[];
  transactions: readonly ProviderTransaction[];
  ledgerAccounts: readonly SyncLedgerAccount[];
  links: readonly SyncAccountLink[];
  /**
   * Ledger accounts already linked to another provider. Name matching will not
   * claim them, so SimpleFIN and Plaid can both be connected on different accounts.
   */
  reservedLedgerIds?: readonly string[];
  books: readonly SyncBookTransaction[];
  rules: readonly PayeeCategoryRule[];
  /** Used when no payee rule matches. The books require every transaction to have a category split. */
  fallbacks?: { incomeCategoryId: string; expenseCategoryId: string };
  /** Rows another part of the same plan already changes; they are not rekeyed again. */
  claimedRowIds?: ReadonlySet<string>;
}): Result<BankSyncPlan, ProviderSyncError> {
  const known = indexKnown(input.providerId, input.householdId, input.books);
  const accountIds = new Set<string>();
  for (const account of input.accounts) {
    if (accountIds.has(account.providerAccountId)) return err(new ProviderSyncError());
    accountIds.add(account.providerAccountId);
  }
  for (const transaction of input.transactions) {
    if (transaction.pending) continue;
    if (!accountIds.has(transaction.providerAccountId)) return err(new ProviderSyncError());
  }
  const ledger = input.ledgerAccounts.filter((account) => account.householdId === input.householdId);
  const linkByProvider = new Map(input.links.map((link) => [link.providerAccountId, link.ledgerAccountId]));
  const linkedLedgerIds = new Set([
    ...input.links.map((link) => link.ledgerAccountId),
    ...(input.reservedLedgerIds ?? []),
  ]);
  const transactionsByAccount = new Map<string, ProviderTransaction[]>();
  for (const transaction of input.transactions) {
    if (transaction.pending) continue;
    const rows = transactionsByAccount.get(transaction.providerAccountId) ?? [];
    rows.push(transaction);
    transactionsByAccount.set(transaction.providerAccountId, rows);
  }

  const accounts: PlannedBankAccount[] = [];
  const planned: PlannedBankTransaction[] = [];
  const updates: PlannedBankUpdate[] = [];
  const claimedLedgerIds = new Set<string>();
  const claimedRows = new Set(input.claimedRowIds ?? []);
  const seen = new Set<string>();
  const matchable: Array<{ ledgerAccountId: string; row: PlannedBankTransaction; authorizedOn?: string }> = [];

  for (const account of input.accounts) {
    if (account.balanceCents != null && !isCents(account.balanceCents)) {
      return err(new ProviderSyncError("The bank sent an amount Dollas cannot store. Try syncing again."));
    }
    const balanceCents = account.balanceCents ?? 0;
    const currency = account.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return err(new ProviderSyncError());
    const rows = transactionsByAccount.get(account.providerAccountId) ?? [];
    const fresh: Array<{ row: PlannedBankTransaction; authorizedOn?: string }> = [];
    for (const transaction of rows) {
      if (!isCents(transaction.amountCents) || !ISO_DATE.test(transaction.occurredOn)) {
        return err(new ProviderSyncError());
      }
      if (transaction.amountCents === 0) continue;
      if (!isStableTransactionId(transaction.providerTransactionId)) return err(new ProviderSyncError());
      const key = identityKey(account.providerAccountId, transaction.providerTransactionId);
      if (seen.has(key)) continue;
      seen.add(key);
      if (known.find(account.providerAccountId, transaction.providerTransactionId)) continue;
      const payee = normalizePayee(transaction.payee);
      const replaced = transaction.pendingTransactionId
        ? known.find(account.providerAccountId, transaction.pendingTransactionId)
        : null;
      if (replaced && !claimedRows.has(replaced.id)) {
        claimedRows.add(replaced.id);
        updates.push({
          transactionId: replaced.id,
          providerAccountId: account.providerAccountId,
          providerTransactionId: transaction.providerTransactionId,
          occurredOn: transaction.occurredOn,
          payee,
          amountCents: transaction.amountCents,
          matched: replaced.matched,
          deleted: replaced.deletedAt != null,
          clearLegacyFingerprint: replaced.bank == null,
        });
        continue;
      }
      const rule = matchingPayeeRule(payee, input.rules);
      fresh.push({
        row: {
          providerAccountId: account.providerAccountId,
          providerTransactionId: transaction.providerTransactionId,
          occurredOn: transaction.occurredOn,
          payee,
          amountCents: transaction.amountCents,
          categoryId: rule?.categoryId ?? fallbackCategory(transaction.amountCents, input.fallbacks),
        },
        ...(transaction.authorizedOn && ISO_DATE.test(transaction.authorizedOn) ? { authorizedOn: transaction.authorizedOn } : {}),
      });
    }

    const existingLedgerId = linkByProvider.get(account.providerAccountId);
    if (existingLedgerId) {
      accounts.push({
        kind: "update",
        providerAccountId: account.providerAccountId,
        ledgerAccountId: existingLedgerId,
        currency,
        balanceCents,
      });
      matchable.push(...fresh.map((entry) => ({ ...entry, ledgerAccountId: existingLedgerId })));
      continue;
    }

    const matched = matchLedgerAccount(account.name, ledger, linkedLedgerIds, claimedLedgerIds);
    if (matched.isErr()) return err(matched.error);
    if (matched.value) {
      const ledgerAccountId = matched.value;
      claimedLedgerIds.add(ledgerAccountId);
      accounts.push({
        kind: "link",
        providerAccountId: account.providerAccountId,
        ledgerAccountId,
        currency,
        balanceCents,
      });
      matchable.push(...fresh.map((entry) => ({ ...entry, ledgerAccountId })));
      continue;
    }

    const opening = openingBalance(balanceCents, fresh.map((entry) => entry.row.amountCents));
    if (opening.isErr()) return err(opening.error);
    const name = ledgerAccountName(account.name);
    accounts.push({
      kind: "create",
      providerAccountId: account.providerAccountId,
      name,
      type: ledgerType(account.type),
      currency,
      balanceCents,
      openingBalanceCents: opening.value,
    });
    planned.push(...fresh.map((entry) => entry.row));
  }

  const candidates = input.books
    .filter((row) => isCandidate(row, input.householdId) && !claimedRows.has(row.id))
    .map((row) => ({
      id: row.id,
      accountId: row.accountId,
      amountCents: row.amountCents,
      dates: [row.occurredOn],
      payee: row.payee,
      deleted: row.deletedAt != null,
      order: row.createdAt,
    }));
  const incoming = matchable.map((entry) => ({
    key: identityKey(entry.row.providerAccountId, entry.row.providerTransactionId),
    accountId: entry.ledgerAccountId,
    amountCents: entry.row.amountCents,
    dates: entry.authorizedOn ? [entry.row.occurredOn, entry.authorizedOn] : [entry.row.occurredOn],
    payee: entry.row.payee,
  }));
  const pairs = new Map(pairCharges(incoming, candidates).map((pair) => [pair.incomingKey, pair.candidateId]));
  const deletedIds = new Set(candidates.filter((row) => row.deleted).map((row) => row.id));
  const links: PlannedBankLink[] = [];
  for (const entry of matchable) {
    const candidateId = pairs.get(identityKey(entry.row.providerAccountId, entry.row.providerTransactionId));
    if (!candidateId) {
      planned.push(entry.row);
      continue;
    }
    links.push({
      transactionId: candidateId,
      providerAccountId: entry.row.providerAccountId,
      providerTransactionId: entry.row.providerTransactionId,
      bankOccurredOn: entry.row.occurredOn,
      bankPayee: entry.row.payee,
      deleted: deletedIds.has(candidateId),
    });
  }

  return ok({ accounts, transactions: planned, links, updates });
}

/** Civil date `days` before `now`, in UTC. The first sync stores this so later syncs do not slide backward. */
export function defaultTransactionsSince(now: Date, days = 90): string {
  const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  utc.setUTCDate(utc.getUTCDate() - days);
  return utc.toISOString().slice(0, 10);
}

export type PlaidSyncPlan = {
  accounts: PlannedBankAccount[];
  added: PlannedBankTransaction[];
  links: PlannedBankLink[];
  updated: PlannedBankUpdate[];
  removed: PlannedBankRemoval[];
};

/**
 * Plan a Plaid `/transactions/sync` page onto the books.
 * Added rows, and modified rows the books do not hold yet, go through
 * {@link planBankSync} (identity skip, pending-to-posted, cross-source match).
 * Modified rows the books hold update that row (see {@link PlannedBankUpdate});
 * a deleted row is left alone. Removed rows hide a row sync created, or unlink
 * a matched row and keep it. Removing a pending id that a posted row in the
 * same page takes over does nothing, so the charge is not lost.
 */
export function planPlaidSync(input: {
  householdId: string;
  accounts: readonly ProviderAccount[];
  added: readonly ProviderTransaction[];
  modified: readonly ProviderTransaction[];
  removed: readonly string[];
  ledgerAccounts: readonly SyncLedgerAccount[];
  links: readonly SyncAccountLink[];
  reservedLedgerIds?: readonly string[];
  books: readonly SyncBookTransaction[];
  rules: readonly PayeeCategoryRule[];
  fallbacks?: { incomeCategoryId: string; expenseCategoryId: string };
}): Result<PlaidSyncPlan, ProviderSyncError> {
  const known = indexKnown(PLAID_PROVIDER_ID, input.householdId, input.books);
  const removedIds = new Set(input.removed);
  const fresh = new Map<string, ProviderTransaction>();
  for (const transaction of input.added) {
    if (transaction.pending || transaction.amountCents === 0) continue;
    if (removedIds.has(transaction.providerTransactionId)) continue;
    fresh.set(transaction.providerTransactionId, transaction);
  }
  const liveEdits: Array<{ transaction: ProviderTransaction; row: SyncBookTransaction }> = [];
  for (const transaction of input.modified) {
    if (transaction.pending || transaction.amountCents === 0) continue;
    if (removedIds.has(transaction.providerTransactionId)) continue;
    const row = known.find(transaction.providerAccountId, transaction.providerTransactionId);
    if (!row) {
      fresh.set(transaction.providerTransactionId, transaction);
      continue;
    }
    if (row.deletedAt != null) continue;
    liveEdits.push({ transaction, row });
  }

  const editedIds = new Set(liveEdits.map((edit) => edit.row.id));
  const planned = planBankSync({
    providerId: PLAID_PROVIDER_ID,
    householdId: input.householdId,
    accounts: input.accounts,
    transactions: [...fresh.values()],
    ledgerAccounts: input.ledgerAccounts,
    links: input.links,
    reservedLedgerIds: input.reservedLedgerIds,
    books: input.books,
    rules: input.rules,
    fallbacks: input.fallbacks,
    claimedRowIds: editedIds,
  });
  if (planned.isErr()) return err(planned.error);

  const updates = [...planned.value.updates];
  const touched = new Set(updates.map((update) => update.transactionId));
  for (const { transaction, row } of liveEdits) {
    if (!isCents(transaction.amountCents) || !ISO_DATE.test(transaction.occurredOn)) {
      return err(new ProviderSyncError());
    }
    if (touched.has(row.id)) continue;
    touched.add(row.id);
    updates.push({
      transactionId: row.id,
      providerAccountId: transaction.providerAccountId,
      providerTransactionId: transaction.providerTransactionId,
      occurredOn: transaction.occurredOn,
      payee: normalizePayee(transaction.payee),
      amountCents: transaction.amountCents,
      matched: row.matched,
      deleted: false,
      clearLegacyFingerprint: row.bank == null,
    });
  }

  const linkedIds = new Set(planned.value.links.map((link) => link.transactionId));
  const removed: PlannedBankRemoval[] = [];
  const seenRemovals = new Set<string>();
  for (const providerTransactionId of input.removed) {
    // Plaid's removed list carries only the transaction id, which is unique across the item.
    const row = knownByTransactionId(input.books, input.householdId, providerTransactionId);
    if (!row || row.deletedAt != null) continue;
    if (seenRemovals.has(row.id) || touched.has(row.id) || linkedIds.has(row.id)) continue;
    seenRemovals.add(row.id);
    removed.push({ transactionId: row.id, matched: row.matched });
  }

  return ok({
    accounts: planned.value.accounts,
    added: planned.value.transactions,
    links: planned.value.links,
    updated: updates,
    removed,
  });
}

function knownByTransactionId(
  books: readonly SyncBookTransaction[],
  householdId: string,
  providerTransactionId: string,
): SyncBookTransaction | null {
  const legacy = providerTransactionFingerprint(PLAID_PROVIDER_ID, providerTransactionId);
  return (
    books.find(
      (row) =>
        row.householdId === householdId &&
        ((row.bank?.providerId === PLAID_PROVIDER_ID && row.bank.providerTransactionId === providerTransactionId) ||
          (legacy.isOk() && row.importFingerprint === legacy.value)),
    ) ?? null
  );
}

function isStableTransactionId(value: string): boolean {
  return value.length >= 1 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function fallbackCategory(
  amountCents: Cents,
  fallbacks: { incomeCategoryId: string; expenseCategoryId: string } | undefined,
): string | null {
  if (!fallbacks) return null;
  const categoryId = amountCents > 0 ? fallbacks.incomeCategoryId : fallbacks.expenseCategoryId;
  return categoryId.length > 0 ? categoryId : null;
}

function matchLedgerAccount(
  name: string,
  ledger: readonly SyncLedgerAccount[],
  linkedLedgerIds: ReadonlySet<string>,
  claimedLedgerIds: ReadonlySet<string>,
): Result<string | null, ProviderSyncError> {
  const key = name.trim().toLowerCase();
  if (!key) return ok(null);
  const candidates = ledger.filter(
    (account) =>
      account.archivedAt === null &&
      !linkedLedgerIds.has(account.id) &&
      !claimedLedgerIds.has(account.id) &&
      account.name.trim().toLowerCase() === key,
  );
  if (candidates.length > 1) {
    const label = ledgerAccountName(name);
    return err(new ProviderSyncError(`Two accounts are named ${label}. Rename one, then sync again.`));
  }
  return ok(candidates[0]?.id ?? null);
}

function openingBalance(balanceCents: Cents, amounts: readonly Cents[]): Result<Cents, ProviderSyncError> {
  let movement = 0;
  for (const amount of amounts) {
    movement += amount;
    if (!Number.isSafeInteger(movement)) {
      return err(new ProviderSyncError("The bank sent an amount Dollas cannot store. Try syncing again."));
    }
  }
  const opening = balanceCents - movement;
  if (!Number.isSafeInteger(opening)) {
    return err(new ProviderSyncError("The bank sent an amount Dollas cannot store. Try syncing again."));
  }
  return ok(opening);
}

function ledgerType(type: ProviderAccountType): AccountType {
  if (type === "checking" || type === "savings" || type === "credit" || type === "cash") return type;
  return "checking";
}

function ledgerAccountName(name: string): string {
  const trimmed = name.trim().replace(/[\u0000-\u001f\u007f]/g, "");
  if (trimmed.length < 2) return "Bank account";
  return trimmed.slice(0, 80);
}

function normalizePayee(payee: string): string {
  const cleaned = payee.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return "Bank transaction";
  return cleaned.slice(0, 200);
}
