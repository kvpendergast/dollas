import { err, ok, type Result } from "neverthrow";
import { retainedImportFingerprints } from "../activity/delete";
import { ProviderSyncError } from "../errors";
import type { AccountType } from "../accounts/ledger";
import { isCents, type Cents } from "../money/cents";
import { matchingPayeeRule, type PayeeCategoryRule } from "../rules/payee-category";
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
  occurredOn: string;
  payee: string;
  amountCents: Cents;
  fingerprint: string;
  categoryId: string | null;
};

export type BankSyncPlan = {
  accounts: PlannedBankAccount[];
  transactions: PlannedBankTransaction[];
};

/**
 * Map a provider snapshot onto the household books.
 * Deleted import fingerprints stay in the known set, so a transaction a member
 * removed is not planned again. Pending rows are not planned. An account that
 * was linked before is updated in place; a new one is created, or matched to
 * a single active ledger account with the same name.
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
  imported: readonly { householdId: string; fingerprint: string | null; deletedAt: string | null }[];
  rules: readonly PayeeCategoryRule[];
  /** Used when no payee rule matches. The books require every transaction to have a category split. */
  fallbacks?: { incomeCategoryId: string; expenseCategoryId: string };
}): Result<BankSyncPlan, ProviderSyncError> {
  const known = new Set(
    retainedImportFingerprints(input.imported, input.householdId).map((row) => row.fingerprint),
  );
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
  const claimedLedgerIds = new Set<string>();

  for (const account of input.accounts) {
    if (account.balanceCents != null && !isCents(account.balanceCents)) {
      return err(new ProviderSyncError("The bank sent an amount Dollas cannot store. Try syncing again."));
    }
    const balanceCents = account.balanceCents ?? 0;
    const currency = account.currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return err(new ProviderSyncError());
    const rows = transactionsByAccount.get(account.providerAccountId) ?? [];
    const fresh: PlannedBankTransaction[] = [];
    for (const transaction of rows) {
      if (!isCents(transaction.amountCents) || !ISO_DATE.test(transaction.occurredOn)) {
        return err(new ProviderSyncError());
      }
      if (transaction.amountCents === 0) continue;
      const fingerprint = providerTransactionFingerprint(input.providerId, transaction.providerTransactionId);
      if (fingerprint.isErr()) return err(new ProviderSyncError());
      if (known.has(fingerprint.value)) continue;
      known.add(fingerprint.value);
      const payee = normalizePayee(transaction.payee);
      const rule = matchingPayeeRule(payee, input.rules);
      fresh.push({
        providerAccountId: account.providerAccountId,
        occurredOn: transaction.occurredOn,
        payee,
        amountCents: transaction.amountCents,
        fingerprint: fingerprint.value,
        categoryId: rule?.categoryId ?? fallbackCategory(transaction.amountCents, input.fallbacks),
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
      planned.push(...fresh);
      continue;
    }

    const matched = matchLedgerAccount(account.name, ledger, linkedLedgerIds, claimedLedgerIds);
    if (matched.isErr()) return err(matched.error);
    if (matched.value) {
      claimedLedgerIds.add(matched.value);
      accounts.push({
        kind: "link",
        providerAccountId: account.providerAccountId,
        ledgerAccountId: matched.value,
        currency,
        balanceCents,
      });
      planned.push(...fresh);
      continue;
    }

    const opening = openingBalance(balanceCents, fresh.map((row) => row.amountCents));
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
    planned.push(...fresh);
  }

  return ok({ accounts, transactions: planned });
}

/** Civil date `days` before `now`, in UTC. The first sync stores this so later syncs do not slide backward. */
export function defaultTransactionsSince(now: Date, days = 90): string {
  const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  utc.setUTCDate(utc.getUTCDate() - days);
  return utc.toISOString().slice(0, 10);
}

export type PlannedBankUpdate = {
  fingerprint: string;
  occurredOn: string;
  payee: string;
  amountCents: Cents;
};

export type PlannedBankRemoval = {
  fingerprint: string;
};

export type PlaidSyncPlan = {
  accounts: PlannedBankAccount[];
  added: PlannedBankTransaction[];
  updated: PlannedBankUpdate[];
  removed: PlannedBankRemoval[];
};

/**
 * Plan a Plaid `/transactions/sync` page onto the books.
 * Added rows use `bank:plaid:{transaction id}` and skip any fingerprint already
 * stored, including one a member deleted. Modified rows update a visible
 * transaction and do not clear `deleted_at`. Removed rows hide a visible
 * transaction. A later sync that lists the same id again does not bring it back.
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
  imported: readonly { householdId: string; fingerprint: string | null; deletedAt: string | null }[];
  rules: readonly PayeeCategoryRule[];
  fallbacks?: { incomeCategoryId: string; expenseCategoryId: string };
}): Result<PlaidSyncPlan, ProviderSyncError> {
  const known = knownFingerprints(input.imported, input.householdId);
  const removedIds = new Set(input.removed);
  const fresh = new Map<string, ProviderTransaction>();
  for (const transaction of input.added) {
    if (transaction.pending || transaction.amountCents === 0) continue;
    if (removedIds.has(transaction.providerTransactionId)) continue;
    fresh.set(transaction.providerTransactionId, transaction);
  }
  const liveEdits: ProviderTransaction[] = [];
  for (const transaction of input.modified) {
    if (transaction.pending || transaction.amountCents === 0) continue;
    if (removedIds.has(transaction.providerTransactionId)) continue;
    const fingerprint = providerTransactionFingerprint(PLAID_PROVIDER_ID, transaction.providerTransactionId);
    if (fingerprint.isErr()) return err(new ProviderSyncError());
    const state = known.get(fingerprint.value);
    if (!state) {
      fresh.set(transaction.providerTransactionId, transaction);
      continue;
    }
    if (state.deleted) continue;
    liveEdits.push(transaction);
  }

  const planned = planBankSync({
    providerId: PLAID_PROVIDER_ID,
    householdId: input.householdId,
    accounts: input.accounts,
    transactions: [...fresh.values()],
    ledgerAccounts: input.ledgerAccounts,
    links: input.links,
    reservedLedgerIds: input.reservedLedgerIds,
    imported: input.imported,
    rules: input.rules,
    fallbacks: input.fallbacks,
  });
  if (planned.isErr()) return err(planned.error);

  const addedFingerprints = new Set(planned.value.transactions.map((row) => row.fingerprint));
  const updated: PlannedBankUpdate[] = [];
  for (const transaction of liveEdits) {
    if (!isCents(transaction.amountCents) || !ISO_DATE.test(transaction.occurredOn)) {
      return err(new ProviderSyncError());
    }
    const fingerprint = providerTransactionFingerprint(PLAID_PROVIDER_ID, transaction.providerTransactionId);
    if (fingerprint.isErr()) return err(new ProviderSyncError());
    if (addedFingerprints.has(fingerprint.value)) continue;
    updated.push({
      fingerprint: fingerprint.value,
      occurredOn: transaction.occurredOn,
      payee: normalizePayee(transaction.payee),
      amountCents: transaction.amountCents,
    });
  }

  const removed: PlannedBankRemoval[] = [];
  const seenRemovals = new Set<string>();
  for (const providerTransactionId of input.removed) {
    const fingerprint = providerTransactionFingerprint(PLAID_PROVIDER_ID, providerTransactionId);
    if (fingerprint.isErr()) continue;
    if (seenRemovals.has(fingerprint.value) || addedFingerprints.has(fingerprint.value)) continue;
    seenRemovals.add(fingerprint.value);
    const state = known.get(fingerprint.value);
    if (!state || state.deleted) continue;
    removed.push({ fingerprint: fingerprint.value });
  }

  return ok({
    accounts: planned.value.accounts,
    added: planned.value.transactions,
    updated,
    removed,
  });
}

function knownFingerprints(
  imported: readonly { householdId: string; fingerprint: string | null; deletedAt: string | null }[],
  householdId: string,
): Map<string, { deleted: boolean }> {
  const known = new Map<string, { deleted: boolean }>();
  if (householdId.trim().length === 0) return known;
  for (const row of imported) {
    if (row.householdId !== householdId || row.fingerprint == null || row.fingerprint.length === 0) continue;
    known.set(row.fingerprint, { deleted: row.deletedAt != null });
  }
  return known;
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
