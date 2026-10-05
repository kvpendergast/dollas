"use server";

import { DomainError, importCsv, resolveCsvRows, validateSplits } from "@dollas/domain";
import { and, eq, isNotNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withActor } from "@/db/actor";
import type { AppTx } from "@/db/client";
import { category, ledgerAccount, transaction, transactionSplit } from "@/db/schema";
import { logError } from "@/lib/telemetry";
import { requireBooks } from "@/slices/access/guard";
import { readTransactionDraft, type TransactionDraft } from "./draft";

const MAX_CSV_BYTES = 1_000_000;

export type ImportCsvState = { error: string; message: string };

export async function importCsvAction(_state: ImportCsvState, formData: FormData): Promise<ImportCsvState> {
  const books = await requireBooks();
  const file = formData.get("csv");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file.", message: "" };
  if (file.size > MAX_CSV_BYTES) return { error: "That CSV is too large.", message: "" };
  const text = await file.text();

  try {
    const inserted = await withActor(books.userId, async (tx) => {
      const accounts = await tx
        .select({ id: ledgerAccount.id, name: ledgerAccount.name })
        .from(ledgerAccount)
        .where(eq(ledgerAccount.householdId, books.householdId));
      const categories = await tx
        .select({ id: category.id, name: category.name })
        .from(category)
        .where(eq(category.householdId, books.householdId));
      const existing = await tx
        .select({ fingerprint: transaction.importFingerprint })
        .from(transaction)
        .where(and(eq(transaction.householdId, books.householdId), isNotNull(transaction.importFingerprint)));
      const outcome = await importCsv(
        text,
        { rows: existing.flatMap((row) => (row.fingerprint ? [{ fingerprint: row.fingerprint }] : [])) },
        (rows) => resolveCsvRows(rows, accounts, categories),
      );
      if (outcome.isErr()) throw outcome.error;
      if (outcome.value.added === 0) return 0;

      const drafts = outcome.value.addedRows.map((row) => {
        const balanced = validateSplits(row.amountCents, [
          { categoryId: row.categoryId, amountCents: row.amountCents },
        ]);
        if (balanced.isErr()) throw balanced.error;
        return { row, splits: balanced.value };
      });
      const saved = await tx
        .insert(transaction)
        .values(
          drafts.map((draft) => ({
            householdId: books.householdId,
            accountId: draft.row.accountId,
            occurredOn: draft.row.occurredOn,
            payee: draft.row.payee,
            amountCents: draft.row.amountCents,
            importFingerprint: draft.row.fingerprint,
          })),
        )
        .onConflictDoNothing({ target: [transaction.householdId, transaction.importFingerprint] })
        .returning({ id: transaction.id, fingerprint: transaction.importFingerprint });
      const idByFingerprint = new Map(
        saved.flatMap((row) => (row.fingerprint ? [[row.fingerprint, row.id] as const] : [])),
      );
      const splits = drafts.flatMap((draft) => {
        const transactionId = idByFingerprint.get(draft.row.fingerprint);
        if (!transactionId) return [];
        return draft.splits.map((split) => ({
          transactionId,
          householdId: books.householdId,
          categoryId: split.categoryId,
          amountCents: split.amountCents,
        }));
      });
      if (splits.length > 0) await tx.insert(transactionSplit).values(splits);
      return idByFingerprint.size;
    });
    revalidatePath("/activity");
    revalidatePath("/");
    revalidatePath("/plan");
    revalidatePath("/history");
    revalidatePath("/projection");
    if (inserted === 0) {
      return { error: "", message: "That CSV was already imported. No new transactions." };
    }
    const label = inserted === 1 ? "transaction" : "transactions";
    return { error: "", message: `Imported ${inserted} ${label}.` };
  } catch (error) {
    logError(error, { action: "import-csv", householdId: books.householdId });
    if (error instanceof DomainError) return { error: error.message, message: "" };
    return { error: "Could not import that CSV.", message: "" };
  }
}

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
): Promise<void> {
  const [accountRow] = await tx
    .select({ id: ledgerAccount.id })
    .from(ledgerAccount)
    .where(and(eq(ledgerAccount.id, accountId), eq(ledgerAccount.householdId, householdId)));
  if (!accountRow) throw new Error("Choose an account in this household.");
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
  return message || "Could not save that transaction.";
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
    return { error: error instanceof Error ? error.message : "Could not save that transaction." };
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
      .select({ id: transaction.id })
      .from(transaction)
      .where(and(eq(transaction.id, transactionId), eq(transaction.householdId, householdId)));
    if (!existing) throw new Error("That transaction is not in this household.");
    await requireHouseholdTargets(
      tx,
      householdId,
      draft.accountId,
      draft.splits.map((split) => split.categoryId),
    );
    const updated = await tx
      .update(transaction)
      .set({
        accountId: draft.accountId,
        occurredOn: draft.occurredOn,
        payee: draft.payee,
        amountCents: draft.amountCents,
      })
      .where(and(eq(transaction.id, transactionId), eq(transaction.householdId, householdId)))
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
