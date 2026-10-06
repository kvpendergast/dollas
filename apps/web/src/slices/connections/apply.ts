import {
  isAccountType,
  matchingPayeeRule,
  planBankSync,
  planPlaidSync,
  PLAID_PROVIDER_ID,
  ProviderSyncError,
  type PayeeCategoryRule,
  type PlannedBankRemoval,
  type PlannedBankTransaction,
  type PlannedBankUpdate,
  type ProviderAccount,
  type ProviderTransaction,
} from "@dollas/domain";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
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
): Promise<{ accounts: number; transactions: number; updated: number; removed: number }> {
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
  const imported = await tx
    .select({
      householdId: transaction.householdId,
      fingerprint: transaction.importFingerprint,
      deletedAt: transaction.deletedAt,
    })
    .from(transaction)
    .where(and(eq(transaction.householdId, input.householdId), isNotNull(transaction.importFingerprint)));
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
          imported: imported.map(importedRow),
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
          imported: imported.map(importedRow),
          rules,
          fallbacks,
        });
  if (plan.isErr()) throw plan.error;
  const plannedTransactions = "added" in plan.value ? plan.value.added : plan.value.transactions;
  const plannedUpdates = "updated" in plan.value ? plan.value.updated : [];
  const plannedRemovals = "removed" in plan.value ? plan.value.removed : [];
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

  const added = await insertPlanned(tx, input.householdId, plannedTransactions, ledgerIdByProvider);
  const updated = await updatePlanned(tx, input.householdId, plannedUpdates);
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

  return { accounts: plan.value.accounts.length, transactions: added, updated, removed: removedCount };
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

function importedRow(row: { householdId: string; fingerprint: string | null; deletedAt: Date | null }) {
  return {
    householdId: row.householdId,
    fingerprint: row.fingerprint,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

async function insertPlanned(
  tx: AppTx,
  householdId: string,
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
        importFingerprint: draft.fingerprint,
      })),
    )
    .onConflictDoNothing({ target: [transaction.householdId, transaction.importFingerprint] })
    .returning({ id: transaction.id, fingerprint: transaction.importFingerprint });
  const idByFingerprint = new Map(saved.flatMap((row) => (row.fingerprint ? [[row.fingerprint, row.id] as const] : [])));
  const splits = drafts.flatMap((draft) => {
    const transactionId = idByFingerprint.get(draft.fingerprint);
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
  return idByFingerprint.size;
}

async function updatePlanned(tx: AppTx, householdId: string, updates: readonly PlannedBankUpdate[]): Promise<number> {
  let count = 0;
  for (const update of updates) {
    const [row] = await tx
      .update(transaction)
      .set({
        occurredOn: update.occurredOn,
        payee: update.payee,
        amountCents: update.amountCents,
      })
      .where(
        and(
          eq(transaction.householdId, householdId),
          eq(transaction.importFingerprint, update.fingerprint),
          isNull(transaction.deletedAt),
        ),
      )
      .returning({ id: transaction.id });
    if (!row) continue;
    const splits = await tx
      .select({ id: transactionSplit.id, amountCents: transactionSplit.amountCents })
      .from(transactionSplit)
      .where(eq(transactionSplit.transactionId, row.id));
    if (splits.length === 1 && splits[0]) {
      await tx
        .update(transactionSplit)
        .set({ amountCents: update.amountCents })
        .where(eq(transactionSplit.id, splits[0].id));
    } else if (splits.length > 1) {
      const sum = splits.reduce((total, split) => total + split.amountCents, 0);
      if (sum !== update.amountCents) {
        await tx.update(transaction).set({ amountCents: sum }).where(eq(transaction.id, row.id));
      }
    }
    count += 1;
  }
  return count;
}

async function removePlanned(tx: AppTx, householdId: string, removals: readonly PlannedBankRemoval[]): Promise<number> {
  let count = 0;
  const deletedAt = new Date();
  for (const removal of removals) {
    const hidden = await tx
      .update(transaction)
      .set({ deletedAt })
      .where(
        and(
          eq(transaction.householdId, householdId),
          eq(transaction.importFingerprint, removal.fingerprint),
          isNull(transaction.deletedAt),
        ),
      )
      .returning({ id: transaction.id });
    count += hidden.length;
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
async function ensureFallbackCategory(tx: AppTx, householdId: string, kind: "income" | "expense"): Promise<string> {
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
