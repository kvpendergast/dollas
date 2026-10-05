"use server";

import { DomainError, importCsv, parseDollarInput, resolveCsvRows, validateSplits } from "@dollas/domain";
import { and, eq, isNotNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withActor } from "@/db/actor";
import { category, ledgerAccount, transaction, transactionSplit } from "@/db/schema";
import { logError } from "@/lib/telemetry";
import { requireBooks } from "@/slices/access/guard";

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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function createTransactionAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const payee = String(formData.get("payee") ?? "").trim();
  const occurredOn = String(formData.get("occurredOn") ?? "");
  const accountId = String(formData.get("accountId") ?? "");
  const direction = String(formData.get("direction") ?? "expense") === "income" ? 1 : -1;
  const amount = parseDollarInput(String(formData.get("amount") ?? ""));
  const categoryIds = formData.getAll("categoryId").map(String).filter(Boolean);
  const splitAmounts = formData.getAll("splitAmount").map(String);
  if (payee.length < 1) return { error: "Enter a payee." };
  if (!ISO_DATE.test(occurredOn)) return { error: "Choose a date." };
  if (amount.isErr()) return { error: amount.error.message };
  if (amount.value <= 0) return { error: "Enter an amount greater than zero." };
  const total = amount.value * direction;
  const drafts =
    categoryIds.length <= 1
      ? [{ categoryId: categoryIds[0] ?? "", amountCents: total }]
      : categoryIds.map((categoryId, index) => {
          const parsed = parseDollarInput(splitAmounts[index] ?? "");
          return {
            categoryId,
            amountCents: parsed.isOk() ? parsed.value * direction : Number.NaN,
          };
        });
  const balanced = validateSplits(total, drafts);
  if (balanced.isErr()) return { error: balanced.error.message };

  try {
    await withActor(books.userId, async (tx) => {
      const [accountRow] = await tx
        .select({ id: ledgerAccount.id })
        .from(ledgerAccount)
        .where(and(eq(ledgerAccount.id, accountId), eq(ledgerAccount.householdId, books.householdId)));
      if (!accountRow) throw new Error("Choose an account in this household.");
      const known = await tx
        .select({ id: category.id })
        .from(category)
        .where(eq(category.householdId, books.householdId));
      const knownIds = new Set(known.map((row) => row.id));
      if (balanced.value.some((split) => !knownIds.has(split.categoryId))) {
        throw new Error("Choose categories from this household.");
      }
      const [row] = await tx
        .insert(transaction)
        .values({
          householdId: books.householdId,
          accountId,
          occurredOn,
          payee,
          amountCents: total,
        })
        .returning();
      await tx.insert(transactionSplit).values(
        balanced.value.map((split) => ({
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
  revalidatePath("/activity");
  revalidatePath("/");
  revalidatePath("/plan");
  revalidatePath("/history");
  revalidatePath("/projection");
  return { error: "" };
}
