import {
  BANK_MATCH_WINDOW_DAYS,
  isAccountType,
  matchingPayeeRule,
  planBankSync,
  planPlaidSync,
  PLAID_PROVIDER_ID,
  ProviderSyncError,
  shiftCivilDate,
  type PayeeCategoryRule,
  type PlannedBankLink,
  type PlannedBankRemoval,
  type PlannedBankTransaction,
  type PlannedBankUpdate,
  type ProviderAccount,
  type ProviderTransaction,
  type SyncBookTransaction,
} from "@dollas/domain";
import { and, eq, gte, inArray, isNull, like, lte, or } from "drizzle-orm";
import type { AppTx } from "@/db/client";
import { bankAccount, bankConnection, category, ledgerAccount, payeeCategoryRule, transaction, transactionSplit } from "@/db/schema";

export async function applyBankSync(
  tx: AppTx,
  input: {
    householdId: string;
    connectionId: string;
    providerId: string;
    since: string;
    accounts: readonly ProviderAccount[];
    transactions: readonly ProviderTransaction[];
    modified?: readonly ProviderTransaction[];
    removed?: readonly string[];
    nextCursor?: string | null;
  },
): Promise<BankSyncCounts> {
  // One sync per connection at a time: a second concurrent sync waits here, then
  // sees the first one's rows and adds nothing (the identity index backs this up).
  await tx
    .select({ id: bankConnection.id })
    .from(bankConnection)
    .where(and(eq(bankConnection.id, input.connectionId), eq(bankConnection.householdId, input.householdId)))
    .for("update");
  const ledgerRows = await tx
    .select({
      id: ledgerAccount.id,
      householdId: ledgerAccount.householdId,
      name: ledgerAccount.name,
      type: ledgerAccount.type,
      archivedAt: ledgerAccount.archivedAt,
    })
    .from(ledgerAccount)
    .where(eq(ledgerAccount.householdId, input.householdId));
  const links = await tx
    .select({
      providerId: bankAccount.providerId,
      providerAccountId: bankAccount.providerAccountId,
      ledgerAccountId: bankAccount.ledgerAccountId,
    })
    .from(bankAccount)
    .where(eq(bankAccount.householdId, input.householdId));
  const books = await loadSyncBooks(tx, input.householdId, input.providerId, [
    ...input.transactions,
    ...(input.modified ?? []),
  ]);
  const rules: PayeeCategoryRule[] = await tx
    .select({ pattern: payeeCategoryRule.pattern, categoryId: payeeCategoryRule.categoryId })
    .from(payeeCategoryRule)
    .where(eq(payeeCategoryRule.householdId, input.householdId));
  const categorized = [...input.transactions, ...(input.modified ?? [])];
  const fallbacks = {
    expenseCategoryId: needsFallback(categorized, rules, -1)
      ? await ensureFallbackCategory(tx, input.householdId, "expense")
      : "",
    incomeCategoryId: needsFallback(categorized, rules, 1)
      ? await ensureFallbackCategory(tx, input.householdId, "income")
      : "",
  };

  const providerLinks = links.filter((link) => link.providerId === input.providerId);
  const reservedLedgerIds = links
    .filter((link) => link.providerId !== input.providerId)
    .map((link) => link.ledgerAccountId);
  const plan =
    input.providerId === PLAID_PROVIDER_ID
      ? planPlaidSync({
          householdId: input.householdId,
          accounts: input.accounts,
          added: input.transactions,
          modified: input.modified ?? [],
          removed: input.removed ?? [],
          ledgerAccounts: ledgerRows.flatMap((row) => ledgerRow(row)),
          links: providerLinks,
          reservedLedgerIds,
          books,
          rules,
          fallbacks,
        })
      : planBankSync({
          providerId: input.providerId,
          householdId: input.householdId,
          accounts: input.accounts,
          transactions: input.transactions,
          ledgerAccounts: ledgerRows.flatMap((row) => ledgerRow(row)),
          links: providerLinks,
          reservedLedgerIds,
          books,
          rules,
          fallbacks,
        });
  if (plan.isErr()) throw plan.error;
  const plannedTransactions = "added" in plan.value ? plan.value.added : plan.value.transactions;
  const plannedUpdates = "updated" in plan.value ? plan.value.updated : plan.value.updates;
  const plannedRemovals = "removed" in plan.value ? plan.value.removed : [];
  const plannedLinks = plan.value.links;
  if (plannedTransactions.some((row) => row.categoryId == null)) {
    throw new ProviderSyncError("The bank sent a transaction Dollas could not categorize. Try syncing again.");
  }

  const ledgerIdByProvider = new Map<string, string>();
  for (const account of plan.value.accounts) {
    if (account.kind === "create") {
      const [created] = await tx
        .insert(ledgerAccount)
        .values({
          householdId: input.householdId,
          name: account.name,
          type: account.type,
          openingBalanceCents: account.openingBalanceCents,
        })
        .returning({ id: ledgerAccount.id });
      await tx.insert(bankAccount).values({
        householdId: input.householdId,
        connectionId: input.connectionId,
        providerId: input.providerId,
        providerAccountId: account.providerAccountId,
        ledgerAccountId: created.id,
        balanceCents: account.balanceCents,
        currency: account.currency,
      });
      ledgerIdByProvider.set(account.providerAccountId, created.id);
      continue;
    }
    if (account.kind === "link") {
      await tx.insert(bankAccount).values({
        householdId: input.householdId,
        connectionId: input.connectionId,
        providerId: input.providerId,
        providerAccountId: account.providerAccountId,
        ledgerAccountId: account.ledgerAccountId,
        balanceCents: account.balanceCents,
        currency: account.currency,
      });
    } else {
      await tx
        .update(bankAccount)
        .set({
          connectionId: input.connectionId,
          balanceCents: account.balanceCents,
          currency: account.currency,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(bankAccount.householdId, input.householdId),
            eq(bankAccount.providerId, input.providerId),
            eq(bankAccount.providerAccountId, account.providerAccountId),
          ),
        );
    }
    ledgerIdByProvider.set(account.providerAccountId, account.ledgerAccountId);
  }

  const added = await insertPlanned(tx, input.householdId, input.providerId, plannedTransactions, ledgerIdByProvider);
  const matched = await linkPlanned(tx, input.householdId, input.providerId, plannedLinks);
  const updated = await updatePlanned(tx, input.householdId, input.providerId, plannedUpdates);
  const removedCount = await removePlanned(tx, input.householdId, plannedRemovals);

  await tx
    .update(bankConnection)
    .set({ transactionsSince: input.since })
    .where(
      and(
        eq(bankConnection.id, input.connectionId),
        eq(bankConnection.householdId, input.householdId),
        isNull(bankConnection.transactionsSince),
      ),
    );
  if (input.nextCursor) {
    await tx
      .update(bankConnection)
      .set({ syncCursor: input.nextCursor })
      .where(and(eq(bankConnection.id, input.connectionId), eq(bankConnection.householdId, input.householdId)));
  }

  return { accounts: plan.value.accounts.length, transactions: added, matched, updated, removed: removedCount };
}

export type BankSyncCounts = {
  accounts: number;
  /** New rows the sync inserted. */
  transactions: number;
  /** Bank charges linked to a CSV or manual row that was already in the books. */
  matched: number;
  updated: number;
  removed: number;
};

/**
 * What the planner needs from the books: every row with a bank identity for
 * this provider (or a legacy `bank:` fingerprint), and CSV or manual rows that
 * could be the same charge as an incoming one (same amount, near the dates).
 * Deleted rows are included. All reads are household-scoped and run under RLS.
 */
async function loadSyncBooks(
  tx: AppTx,
  householdId: string,
  providerId: string,
  incoming: readonly ProviderTransaction[],
): Promise<SyncBookTransaction[]> {
  const columns = {
    id: transaction.id,
    householdId: transaction.householdId,
    accountId: transaction.accountId,
    occurredOn: transaction.occurredOn,
    payee: transaction.payee,
    amountCents: transaction.amountCents,
    deletedAt: transaction.deletedAt,
    createdAt: transaction.createdAt,
    bankProviderId: transaction.bankProviderId,
    bankAccountRef: transaction.bankAccountRef,
    bankTransactionId: transaction.bankTransactionId,
    bankMatchedAt: transaction.bankMatchedAt,
    importFingerprint: transaction.importFingerprint,
  };
  const known = await tx
    .select(columns)
    .from(transaction)
    .where(
      and(
        eq(transaction.householdId, householdId),
        or(eq(transaction.bankProviderId, providerId), like(transaction.importFingerprint, "bank:%")),
      ),
    );
  const live = incoming.filter((row) => !row.pending && row.amountCents !== 0);
  let candidates: typeof known = [];
  if (live.length > 0) {
    const dates = live.flatMap((row) => (row.authorizedOn ? [row.occurredOn, row.authorizedOn] : [row.occurredOn])).sort();
    const amounts = [...new Set(live.map((row) => row.amountCents))];
    candidates = await tx
      .select(columns)
      .from(transaction)
      .where(
        and(
          eq(transaction.householdId, householdId),
          isNull(transaction.bankTransactionId),
          inArray(transaction.amountCents, amounts),
          gte(transaction.occurredOn, shiftCivilDate(dates[0] ?? "", -BANK_MATCH_WINDOW_DAYS)),
          lte(transaction.occurredOn, shiftCivilDate(dates[dates.length - 1] ?? "", BANK_MATCH_WINDOW_DAYS)),
        ),
      );
  }
  const seen = new Set<string>();
  const rows: SyncBookTransaction[] = [];
  for (const row of [...known, ...candidates]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push({
      id: row.id,
      householdId: row.householdId,
      accountId: row.accountId,
      occurredOn: row.occurredOn,
      payee: row.payee,
      amountCents: row.amountCents,
      deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      bank:
        row.bankProviderId && row.bankAccountRef && row.bankTransactionId
          ? { providerId: row.bankProviderId, providerAccountId: row.bankAccountRef, providerTransactionId: row.bankTransactionId }
          : null,
      importFingerprint: row.importFingerprint,
      matched: row.bankMatchedAt != null,
    });
  }
  return rows;
}

function ledgerRow(row: {
  id: string;
  householdId: string;
  name: string;
  type: string;
  archivedAt: Date | null;
}) {
  if (!isAccountType(row.type)) return [];
  return [
    {
      id: row.id,
      householdId: row.householdId,
      name: row.name,
      type: row.type,
      archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    },
  ];
}

async function insertPlanned(
  tx: AppTx,
  householdId: string,
  providerId: string,
  planned: readonly PlannedBankTransaction[],
  ledgerIdByProvider: ReadonlyMap<string, string>,
): Promise<number> {
  const drafts = planned.flatMap((row) => {
    const accountId = ledgerIdByProvider.get(row.providerAccountId);
    if (!accountId) return [];
    return [{ ...row, accountId }];
  });
  if (drafts.length === 0) return 0;
  const saved = await tx
    .insert(transaction)
    .values(
      drafts.map((draft) => ({
        householdId,
        accountId: draft.accountId,
        occurredOn: draft.occurredOn,
        payee: draft.payee,
        amountCents: draft.amountCents,
        bankProviderId: providerId,
        bankAccountRef: draft.providerAccountId,
        bankTransactionId: draft.providerTransactionId,
      })),
    )
    .onConflictDoNothing({
      target: [transaction.householdId, transaction.bankProviderId, transaction.bankAccountRef, transaction.bankTransactionId],
    })
    .returning({ id: transaction.id, accountRef: transaction.bankAccountRef, transactionId: transaction.bankTransactionId });
  const idByIdentity = new Map(saved.map((row) => [`${row.accountRef}\u0000${row.transactionId}`, row.id] as const));
  const splits = drafts.flatMap((draft) => {
    const transactionId = idByIdentity.get(`${draft.providerAccountId}\u0000${draft.providerTransactionId}`);
    if (!transactionId || !draft.categoryId || draft.amountCents === 0) return [];
    return [
      {
        transactionId,
        householdId,
        categoryId: draft.categoryId,
        amountCents: draft.amountCents,
      },
    ];
  });
  if (splits.length > 0) await tx.insert(transactionSplit).values(splits);
  return idByIdentity.size;
}

/** Record the bank identity on CSV or manual rows. The member's payee, date, category, splits, note, and deleted state stay. */
async function linkPlanned(
  tx: AppTx,
  householdId: string,
  providerId: string,
  links: readonly PlannedBankLink[],
): Promise<number> {
  let count = 0;
  const now = new Date();
  for (const link of links) {
    const linked = await tx
      .update(transaction)
      .set({
        bankProviderId: providerId,
        bankAccountRef: link.providerAccountId,
        bankTransactionId: link.providerTransactionId,
        bankMatchedAt: now,
        bankOccurredOn: link.bankOccurredOn,
        bankPayee: link.bankPayee,
      })
      .where(and(eq(transaction.id, link.transactionId), eq(transaction.householdId, householdId), isNull(transaction.bankTransactionId)))
      .returning({ id: transaction.id });
    count += linked.length;
  }
  return count;
}

async function updatePlanned(
  tx: AppTx,
  householdId: string,
  providerId: string,
  updates: readonly PlannedBankUpdate[],
): Promise<number> {
  let count = 0;
  for (const update of updates) {
    const identity = {
      bankProviderId: providerId,
      bankAccountRef: update.providerAccountId,
      bankTransactionId: update.providerTransactionId,
      ...(update.clearLegacyFingerprint ? { importFingerprint: null } : {}),
    };
    const values = update.deleted
      ? identity
      : update.matched
        ? { ...identity, amountCents: update.amountCents, bankOccurredOn: update.occurredOn, bankPayee: update.payee }
        : { ...identity, occurredOn: update.occurredOn, payee: update.payee, amountCents: update.amountCents };
    const [row] = await tx
      .update(transaction)
      .set(values)
      .where(and(eq(transaction.householdId, householdId), eq(transaction.id, update.transactionId)))
      .returning({ id: transaction.id });
    if (!row) continue;
    if (!update.deleted) await rebalanceSplits(tx, row.id, update.amountCents);
    count += 1;
  }
  return count;
}

/** One split follows the new amount. Several splits are the member's; if they no longer add up, the amount follows them. */
async function rebalanceSplits(tx: AppTx, transactionId: string, amountCents: number): Promise<void> {
  const splits = await tx
    .select({ id: transactionSplit.id, amountCents: transactionSplit.amountCents })
    .from(transactionSplit)
    .where(eq(transactionSplit.transactionId, transactionId));
  if (splits.length === 1 && splits[0]) {
    await tx.update(transactionSplit).set({ amountCents }).where(eq(transactionSplit.id, splits[0].id));
  } else if (splits.length > 1) {
    const sum = splits.reduce((total, split) => total + split.amountCents, 0);
    if (sum !== amountCents) {
      await tx.update(transaction).set({ amountCents: sum }).where(eq(transaction.id, transactionId));
    }
  }
}

/** A row sync created is hidden. A matched row is unlinked and kept: the member's CSV or entry still backs it. */
async function removePlanned(tx: AppTx, householdId: string, removals: readonly PlannedBankRemoval[]): Promise<number> {
  let count = 0;
  const deletedAt = new Date();
  for (const removal of removals) {
    const changed = await tx
      .update(transaction)
      .set(
        removal.matched
          ? {
              bankProviderId: null,
              bankAccountRef: null,
              bankTransactionId: null,
              bankMatchedAt: null,
              bankOccurredOn: null,
              bankPayee: null,
            }
          : { deletedAt },
      )
      .where(
        and(eq(transaction.householdId, householdId), eq(transaction.id, removal.transactionId), isNull(transaction.deletedAt)),
      )
      .returning({ id: transaction.id });
    if (!removal.matched) count += changed.length;
  }
  return count;
}

function needsFallback(
  transactions: readonly ProviderTransaction[],
  rules: readonly PayeeCategoryRule[],
  sign: 1 | -1,
): boolean {
  return transactions.some((transaction) => {
    if (transaction.pending || transaction.amountCents === 0) return false;
    if (Math.sign(transaction.amountCents) !== sign) return false;
    return matchingPayeeRule(transaction.payee, rules) == null;
  });
}

/** The books require a category split. Unmatched payees use a standing uncategorized category. */
export async function ensureFallbackCategory(tx: AppTx, householdId: string, kind: "income" | "expense"): Promise<string> {
  const name = kind === "income" ? "Uncategorized income" : "Uncategorized";
  const [existing] = await tx
    .select({ id: category.id })
    .from(category)
    .where(and(eq(category.householdId, householdId), eq(category.kind, kind), eq(category.name, name)));
  if (existing) return existing.id;
  const [created] = await tx
    .insert(category)
    .values({ householdId, name, kind, sortOrder: 1000 })
    .returning({ id: category.id });
  return created.id;
}
