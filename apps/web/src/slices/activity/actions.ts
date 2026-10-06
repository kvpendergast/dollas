"use server";

import {
  DomainError,
  accountAcceptsCorrection,
  accountAcceptsNewEntry,
  deleteTransaction,
  memberFacingMessage,
  restoreTransaction,
  TransactionError,
} from "@dollas/domain";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withActor } from "@/db/actor";
import type { AppTx } from "@/db/client";
import { category, ledgerAccount, transaction, transactionSplit } from "@/db/schema";
import { logError } from "@/lib/telemetry";
import { requireBooks } from "@/slices/access/guard";
import { readTransactionDraft, type TransactionDraft } from "./draft";

const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function revalidateBooks() {
  revalidatePath("/activity");
  revalidatePath("/");
  revalidatePath("/plan");
  revalidatePath("/history");
  revalidatePath("/projection");
}

async function requireHouseholdTargets(
  tx: AppTx,
  householdId: string,
  accountId: string,
  categoryIds: readonly string[],
  placement: { kind: "new" } | { kind: "correction"; currentAccountId: string },
): Promise<void> {
  const [accountRow] = await tx
    .select({
      id: ledgerAccount.id,
      householdId: ledgerAccount.householdId,
      archivedAt: ledgerAccount.archivedAt,
    })
    .from(ledgerAccount)
    .where(and(eq(ledgerAccount.id, accountId), eq(ledgerAccount.householdId, householdId)));
  const account = accountRow
    ? {
        id: accountRow.id,
        householdId: accountRow.householdId,
        archivedAt: accountRow.archivedAt ? accountRow.archivedAt.toISOString() : null,
      }
    : null;
  const accepted =
    placement.kind === "new"
      ? accountAcceptsNewEntry(account, householdId)
      : accountAcceptsCorrection(account, householdId, placement.currentAccountId);
  if (accepted.isErr()) throw accepted.error;
  const known = await tx.select({ id: category.id }).from(category).where(eq(category.householdId, householdId));
  const knownIds = new Set(known.map((row) => row.id));
  if (categoryIds.some((categoryId) => !knownIds.has(categoryId))) {
    throw new Error("Choose categories from this household.");
  }
}

function correctionError(error: unknown): string {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const message = error instanceof Error ? error.message : "";
  if (`${message} ${cause}`.includes("category splits must add up")) {
    return "Category splits must add up to the transaction amount.";
  }
  return memberFacingMessage(error, "Could not save that transaction.");
}

export async function createTransactionAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const parsed = readTransactionDraft(formData);
  if ("error" in parsed) return { error: parsed.error };

  try {
    await withActor(books.userId, async (tx) => {
      await requireHouseholdTargets(
        tx,
        books.householdId,
        parsed.draft.accountId,
        parsed.draft.splits.map((split) => split.categoryId),
        { kind: "new" },
      );
      const [row] = await tx
        .insert(transaction)
        .values({
          householdId: books.householdId,
          accountId: parsed.draft.accountId,
          occurredOn: parsed.draft.occurredOn,
          payee: parsed.draft.payee,
          amountCents: parsed.draft.amountCents,
        })
        .returning();
      await tx.insert(transactionSplit).values(
        parsed.draft.splits.map((split) => ({
          transactionId: row.id,
          householdId: books.householdId,
          categoryId: split.categoryId,
          amountCents: split.amountCents,
        })),
      );
    });
  } catch (error) {
    logError(error, { action: "create-transaction", householdId: books.householdId });
    return { error: memberFacingMessage(error, "Could not save that transaction.") };
  }
  revalidateBooks();
  return { error: "" };
}

export async function updateTransactionAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const transactionId = String(formData.get("transactionId") ?? "");
  if (!TRANSACTION_ID.test(transactionId)) return { error: "That transaction is not in this household." };
  const parsed = readTransactionDraft(formData);
  if ("error" in parsed) return { error: parsed.error };

  try {
    await replaceTransaction(books.userId, books.householdId, transactionId, parsed.draft);
  } catch (error) {
    logError(error, { action: "update-transaction", householdId: books.householdId, transactionId });
    return { error: correctionError(error) };
  }
  revalidateBooks();
  return { error: "" };
}

async function replaceTransaction(
  userId: string,
  householdId: string,
  transactionId: string,
  draft: TransactionDraft,
): Promise<void> {
  await withActor(userId, async (tx) => {
    const [existing] = await tx
      .select({ id: transaction.id, accountId: transaction.accountId, deletedAt: transaction.deletedAt })
      .from(transaction)
      .where(and(eq(transaction.id, transactionId), eq(transaction.householdId, householdId)));
    if (!existing || existing.deletedAt) throw new Error("That transaction is not in this household.");
    await requireHouseholdTargets(
      tx,
      householdId,
      draft.accountId,
      draft.splits.map((split) => split.categoryId),
      { kind: "correction", currentAccountId: existing.accountId },
    );
    // This edit is one transaction. Payee rules stay as they are.
    const updated = await tx
      .update(transaction)
      .set({
        accountId: draft.accountId,
        occurredOn: draft.occurredOn,
        payee: draft.payee,
        amountCents: draft.amountCents,
      })
      .where(
        and(
          eq(transaction.id, transactionId),
          eq(transaction.householdId, householdId),
          isNull(transaction.deletedAt),
        ),
      )
      .returning({ id: transaction.id });
    if (updated.length === 0) throw new Error("That transaction is not in this household.");
    // Replaced in this transaction so the deferred balance trigger sees the final set.
    await tx
      .delete(transactionSplit)
      .where(and(eq(transactionSplit.transactionId, transactionId), eq(transactionSplit.householdId, householdId)));
    await tx.insert(transactionSplit).values(
      draft.splits.map((split) => ({
        transactionId,
        householdId,
        categoryId: split.categoryId,
        amountCents: split.amountCents,
      })),
    );
  });
}

export async function deleteTransactionAction(transactionId: string): Promise<{ error: string }> {
  const books = await requireBooks();
  if (!TRANSACTION_ID.test(transactionId)) return { error: "That transaction is not in this household." };
  try {
    await withActor(books.userId, async (tx) => {
      const current = await loadStored(tx, books.householdId, transactionId);
      const decision = deleteTransaction(current, books.householdId, new Date().toISOString());
      if (decision.isErr()) throw decision.error;
      const stamp = decision.value.deletedAt;
      if (!stamp) throw new TransactionError("Could not delete that transaction.");
      // The fingerprint stays. Payee rules are not updated.
      await tx
        .update(transaction)
        .set({ deletedAt: new Date(stamp) })
        .where(and(eq(transaction.id, transactionId), eq(transaction.householdId, books.householdId)));
    });
  } catch (error) {
    logError(error, { action: "delete-transaction", householdId: books.householdId, transactionId });
    if (error instanceof DomainError) return { error: memberFacingMessage(error, "Could not delete that transaction.") };
    return { error: "Could not delete that transaction." };
  }
  revalidateBooks();
  return { error: "" };
}

export async function restoreTransactionAction(transactionId: string): Promise<{ error: string }> {
  const books = await requireBooks();
  if (!TRANSACTION_ID.test(transactionId)) return { error: "That transaction is not in this household." };
  try {
    await withActor(books.userId, async (tx) => {
      const current = await loadStored(tx, books.householdId, transactionId);
      const decision = restoreTransaction(current, books.householdId);
      if (decision.isErr()) throw decision.error;
      await tx
        .update(transaction)
        .set({ deletedAt: null })
        .where(and(eq(transaction.id, transactionId), eq(transaction.householdId, books.householdId)));
    });
  } catch (error) {
    logError(error, { action: "restore-transaction", householdId: books.householdId, transactionId });
    if (error instanceof DomainError) return { error: memberFacingMessage(error, "Could not restore that transaction.") };
    return { error: "Could not restore that transaction." };
  }
  revalidateBooks();
  return { error: "" };
}

async function loadStored(tx: AppTx, householdId: string, transactionId: string) {
  const [row] = await tx
    .select({
      id: transaction.id,
      householdId: transaction.householdId,
      importFingerprint: transaction.importFingerprint,
      deletedAt: transaction.deletedAt,
    })
    .from(transaction)
    .where(and(eq(transaction.id, transactionId), eq(transaction.householdId, householdId)));
  if (!row) return null;
  return {
    id: row.id,
    householdId: row.householdId,
    importFingerprint: row.importFingerprint,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}
