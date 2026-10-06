import {
  isAccountType,
  matchingPayeeRule,
  planBankSync,
  ProviderSyncError,
  SIMPLEFIN_PROVIDER_ID,
  type PayeeCategoryRule,
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
    since: string;
    accounts: readonly ProviderAccount[];
    transactions: readonly ProviderTransaction[];
  },
): Promise<{ accounts: number; transactions: number }> {
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
      providerAccountId: bankAccount.providerAccountId,
      ledgerAccountId: bankAccount.ledgerAccountId,
    })
    .from(bankAccount)
    .where(and(eq(bankAccount.householdId, input.householdId), eq(bankAccount.providerId, SIMPLEFIN_PROVIDER_ID)));
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
  const fallbacks = {
    expenseCategoryId: needsFallback(input.transactions, rules, -1)
      ? await ensureFallbackCategory(tx, input.householdId, "expense")
      : "",
    incomeCategoryId: needsFallback(input.transactions, rules, 1)
      ? await ensureFallbackCategory(tx, input.householdId, "income")
      : "",
  };

  const plan = planBankSync({
    providerId: SIMPLEFIN_PROVIDER_ID,
    householdId: input.householdId,
    accounts: input.accounts,
    transactions: input.transactions,
    ledgerAccounts: ledgerRows.flatMap((row) => {
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
    }),
    links,
    imported: imported.map((row) => ({
      householdId: row.householdId,
      fingerprint: row.fingerprint,
      deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    })),
    rules,
    fallbacks,
  });
  if (plan.isErr()) throw plan.error;
  if (plan.value.transactions.some((row) => row.categoryId == null)) {
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
        providerId: SIMPLEFIN_PROVIDER_ID,
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
        providerId: SIMPLEFIN_PROVIDER_ID,
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
            eq(bankAccount.providerId, SIMPLEFIN_PROVIDER_ID),
            eq(bankAccount.providerAccountId, account.providerAccountId),
          ),
        );
    }
    ledgerIdByProvider.set(account.providerAccountId, account.ledgerAccountId);
  }

  const drafts = plan.value.transactions.flatMap((row) => {
    const accountId = ledgerIdByProvider.get(row.providerAccountId);
    if (!accountId) return [];
    return [{ ...row, accountId }];
  });
  let added = 0;
  if (drafts.length > 0) {
    const saved = await tx
      .insert(transaction)
      .values(
        drafts.map((draft) => ({
          householdId: input.householdId,
          accountId: draft.accountId,
          occurredOn: draft.occurredOn,
          payee: draft.payee,
          amountCents: draft.amountCents,
          importFingerprint: draft.fingerprint,
        })),
      )
      .onConflictDoNothing({ target: [transaction.householdId, transaction.importFingerprint] })
      .returning({ id: transaction.id, fingerprint: transaction.importFingerprint });
    const idByFingerprint = new Map(
      saved.flatMap((row) => (row.fingerprint ? [[row.fingerprint, row.id] as const] : [])),
    );
    const splits = drafts.flatMap((draft) => {
      const transactionId = idByFingerprint.get(draft.fingerprint);
      if (!transactionId || !draft.categoryId || draft.amountCents === 0) return [];
      return [
        {
          transactionId,
          householdId: input.householdId,
          categoryId: draft.categoryId,
          amountCents: draft.amountCents,
        },
      ];
    });
    if (splits.length > 0) await tx.insert(transactionSplit).values(splits);
    added = idByFingerprint.size;
  }

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

  return { accounts: plan.value.accounts.length, transactions: added };
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
