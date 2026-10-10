import { err, ok, type Result } from "neverthrow";
import { ProviderSyncError } from "../errors";
import type { AccountType } from "../accounts/ledger";
import { isCents, type Cents } from "../money/cents";
import { matchingPayeeRule, type PayeeCategoryRule } from "../rules/payee-category";
import { BANK_MATCH_WINDOW_DAYS, pairCharges, shiftCivilDate } from "./match";
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
  /**
   * False when the connection that fed this account was disconnected (its
   * `bank_account` row has no connection). Missing means active. Only an
   * inactive link can be reattached to a new provider account, and only rows
   * from inactive accounts are re-keyed (PEN-251).
   */
  active?: boolean;
  /** The provider's own account name and mask from the last sync, when stored. */
  providerName?: string | null;
  mask?: string | null;
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
    }
  | {
      /**
       * A reconnect (PEN-251): the provider gave an account Dollas already
       * follows a new id. Re-point the old `bank_account` row instead of
       * creating a second ledger account.
       */
      kind: "reattach";
      providerAccountId: string;
      previousProviderAccountId: string;
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
  /** The bank's own date for a matched row (the member may have changed the book date). */
  bankOccurredOn?: string | null;
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

/**
 * Move a charge's bank identity to the id a reconnected provider now uses
 * (PEN-251). Only the identity changes: the member's date, payee, category
 * lines, notes, recurring link, attribution, and a soft delete all stay.
 */
export type PlannedBankRekey = {
  transactionId: string;
  previous: { providerAccountId: string; providerTransactionId: string };
  providerAccountId: string;
  providerTransactionId: string;
  deleted: boolean;
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
  rekeys: PlannedBankRekey[];
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
 * - Reconnects (PEN-251). A provider can give the same bank account and its
 *   charges new ids after a reconnect (a new Plaid item after a disconnect).
 *   A new provider account is reattached to a disconnected link of the same
 *   provider when exactly one fits ({@link planReattachments}). Then fresh
 *   charges on an account are paired first with rows whose identity belongs to
 *   an account no active connection feeds ("stale" rows), using the PEN-203
 *   rules, and a pair re-keys that row instead of inserting. Rows from a link
 *   that is still active are never re-keyed. Re-running finds the new ids and
 *   does nothing.
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
  /**
   * The connection's first date. Stale rows dated more than the match window
   * before it are not re-key candidates, since the provider will not send
   * their charges again (and a different charge must not claim them).
   */
  since?: string;
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
  const reattach = planReattachments(input.accounts, input.links, ledger);
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

    const moved = reattach.get(account.providerAccountId);
    if (moved) {
      accounts.push({
        kind: "reattach",
        providerAccountId: account.providerAccountId,
        previousProviderAccountId: moved.providerAccountId,
        ledgerAccountId: moved.ledgerAccountId,
        currency,
        balanceCents,
      });
      matchable.push(...fresh.map((entry) => ({ ...entry, ledgerAccountId: moved.ledgerAccountId })));
      continue;
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

  // PEN-251: the bank's own earlier copies first. A row whose identity belongs
  // to an account no active connection feeds is the same charge under an old id.
  const activeRefs = new Set([
    ...input.links.filter((link) => link.active !== false).map((link) => link.providerAccountId),
    ...input.accounts.map((account) => account.providerAccountId),
  ]);
  const staleFrom = input.since && ISO_DATE.test(input.since) ? shiftCivilDate(input.since, -BANK_MATCH_WINDOW_DAYS) : null;
  const matchableLedgerIds = new Set(matchable.map((entry) => entry.ledgerAccountId));
  const stale = input.books.filter(
    (row) =>
      row.householdId === input.householdId &&
      row.bank != null &&
      row.bank.providerId === input.providerId &&
      !activeRefs.has(row.bank.providerAccountId) &&
      matchableLedgerIds.has(row.accountId) &&
      !claimedRows.has(row.id) &&
      (staleFrom == null || row.occurredOn >= staleFrom || (row.bankOccurredOn != null && row.bankOccurredOn >= staleFrom)),
  );
  const staleIncoming = matchable.map((entry) => ({
    key: identityKey(entry.row.providerAccountId, entry.row.providerTransactionId),
    accountId: entry.ledgerAccountId,
    amountCents: entry.row.amountCents,
    dates: entry.authorizedOn ? [entry.row.occurredOn, entry.authorizedOn] : [entry.row.occurredOn],
    payee: entry.row.payee,
  }));
  const staleById = new Map(stale.map((row) => [row.id, row]));
  const rekeyPairs = pairCharges(
    staleIncoming,
    stale.map((row) => ({
      id: row.id,
      accountId: row.accountId,
      amountCents: row.amountCents,
      dates: row.bankOccurredOn ? [row.occurredOn, row.bankOccurredOn] : [row.occurredOn],
      payee: row.payee,
      deleted: row.deletedAt != null,
      order: row.createdAt,
    })),
  );
  const rekeys: PlannedBankRekey[] = [];
  const rekeyedKeys = new Set<string>();
  const incomingByKey = new Map(matchable.map((entry) => [identityKey(entry.row.providerAccountId, entry.row.providerTransactionId), entry.row]));
  for (const pair of rekeyPairs) {
    const row = staleById.get(pair.candidateId);
    const next = incomingByKey.get(pair.incomingKey);
    if (!row?.bank || !next) continue;
    claimedRows.add(row.id);
    rekeyedKeys.add(pair.incomingKey);
    rekeys.push({
      transactionId: row.id,
      previous: { providerAccountId: row.bank.providerAccountId, providerTransactionId: row.bank.providerTransactionId },
      providerAccountId: next.providerAccountId,
      providerTransactionId: next.providerTransactionId,
      deleted: row.deletedAt != null,
    });
  }
  const remaining = matchable.filter((entry) => !rekeyedKeys.has(identityKey(entry.row.providerAccountId, entry.row.providerTransactionId)));

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
  const incoming = remaining.map((entry) => ({
    key: identityKey(entry.row.providerAccountId, entry.row.providerTransactionId),
    accountId: entry.ledgerAccountId,
    amountCents: entry.row.amountCents,
    dates: entry.authorizedOn ? [entry.row.occurredOn, entry.authorizedOn] : [entry.row.occurredOn],
    payee: entry.row.payee,
  }));
  const pairs = new Map(pairCharges(incoming, candidates).map((pair) => [pair.incomingKey, pair.candidateId]));
  const deletedIds = new Set(candidates.filter((row) => row.deleted).map((row) => row.id));
  const links: PlannedBankLink[] = [];
  for (const entry of remaining) {
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

  return ok({ accounts, transactions: planned, links, updates, rekeys });
}

/**
 * Which new provider accounts are accounts Dollas already follows under an
 * old id (PEN-251). A candidate is a link of the same provider that is
 * inactive (its connection was disconnected), not in this snapshot, and on an
 * active ledger account of the same type. It fits when both masks are known
 * and equal, or, when either mask is unknown, when the names match (the
 * provider name stored at the last sync, else the ledger account's name).
 * Only one-to-one fits count: an account with two candidates, or a link two
 * accounts fit, is left alone and gets today's behavior (a name match or a new
 * ledger account), because guessing wrong would merge two real accounts.
 */
export function planReattachments(
  accounts: readonly ProviderAccount[],
  links: readonly SyncAccountLink[],
  ledger: readonly SyncLedgerAccount[],
): Map<string, SyncAccountLink> {
  const incomingIds = new Set(accounts.map((account) => account.providerAccountId));
  const linkedIds = new Set(links.map((link) => link.providerAccountId));
  const ledgerById = new Map(ledger.map((account) => [account.id, account]));
  const stale = links.filter((link) => {
    if (link.active !== false || incomingIds.has(link.providerAccountId)) return false;
    const target = ledgerById.get(link.ledgerAccountId);
    return target != null && target.archivedAt === null;
  });
  const fits = new Map<string, SyncAccountLink[]>();
  const claims = new Map<string, number>();
  for (const account of accounts) {
    if (linkedIds.has(account.providerAccountId)) continue;
    const found = stale.filter((link) => {
      const target = ledgerById.get(link.ledgerAccountId);
      if (!target || target.type !== ledgerType(account.type)) return false;
      const mask = account.mask?.trim().toLowerCase();
      const known = link.mask?.trim().toLowerCase();
      if (mask && known) return mask === known;
      const name = (link.providerName ?? target.name).trim().toLowerCase();
      return name.length > 0 && name === account.name.trim().toLowerCase();
    });
    fits.set(account.providerAccountId, found);
    for (const link of found) claims.set(link.providerAccountId, (claims.get(link.providerAccountId) ?? 0) + 1);
  }
  const chosen = new Map<string, SyncAccountLink>();
  for (const [providerAccountId, found] of fits) {
    if (found.length === 1 && claims.get(found[0].providerAccountId) === 1) chosen.set(providerAccountId, found[0]);
  }
  return chosen;
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
  rekeys: PlannedBankRekey[];
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
  since?: string;
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
    since: input.since,
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

  const linkedIds = new Set([...planned.value.links.map((link) => link.transactionId), ...planned.value.rekeys.map((rekey) => rekey.transactionId)]);
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
    rekeys: planned.value.rekeys,
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
