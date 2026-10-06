"use server";

import {
  CSV_IMPORT_MAX_CHARS,
  CsvImportError,
  DomainError,
  accountsForActiveLists,
  csvTooLargeMessage,
  formatCents,
  importCsv,
  memberFacingMessage,
  previewCsvImport,
  resolveCsvRows,
  retainedImportFingerprints,
  transactionsRemovedByUndo,
  validateSplits,
  type CsvPreview,
  type PayeeCategoryRule,
  type ResolvedCsvRow,
} from "@dollas/domain";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withActor } from "@/db/actor";
import type { AppTx } from "@/db/client";
import { category, csvImport, ledgerAccount, payeeCategoryRule, transaction, transactionSplit } from "@/db/schema";
import { logError } from "@/lib/telemetry";
import { requireBooks } from "@/slices/access/guard";

const BATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ImportPreviewRow = {
  line: number;
  occurredOn: string;
  payee: string;
  amount: string;
  accountName: string;
  categoryName: string;
  status: "new" | "already";
};

export type ImportPreview = {
  stamp: string;
  newCount: number;
  alreadyCount: number;
  parsedRows: number;
  rows: ImportPreviewRow[];
};

export type ImportCsvState = {
  error: string;
  message: string;
  preview: ImportPreview | null;
};

export type UndoImportState = { error: string; message: string };

export type OpenCsvImport = {
  id: string;
  addedCount: number;
  createdAt: string;
};

export async function importCsvAction(_state: ImportCsvState, formData: FormData): Promise<ImportCsvState> {
  const intent = String(formData.get("intent") ?? "preview");
  if (intent === "commit") return commitCsv(formData);
  return previewCsv(formData);
}

export async function undoCsvImportAction(_state: UndoImportState, formData: FormData): Promise<UndoImportState> {
  const books = await requireBooks();
  const batchId = String(formData.get("batchId") ?? "");
  if (!BATCH_ID.test(batchId)) return { error: "That import is not in this household.", message: "" };

  try {
    const removed = await withActor(books.userId, async (tx) => {
      const [batch] = await tx
        .select({ id: csvImport.id, undoneAt: csvImport.undoneAt })
        .from(csvImport)
        .where(and(eq(csvImport.id, batchId), eq(csvImport.householdId, books.householdId)));
      if (!batch) throw new CsvImportError("That import is not in this household.");
      if (batch.undoneAt) throw new CsvImportError("That import was already undone.");

      const candidates = await tx
        .select({
          id: transaction.id,
          householdId: transaction.householdId,
          importBatchId: transaction.importBatchId,
          importFingerprint: transaction.importFingerprint,
          deletedAt: transaction.deletedAt,
        })
        .from(transaction)
        .where(and(eq(transaction.householdId, books.householdId), eq(transaction.importBatchId, batchId)));
      const victims = transactionsRemovedByUndo(
        candidates.map((row) => ({
          id: row.id,
          householdId: row.householdId,
          importBatchId: row.importBatchId,
          importFingerprint: row.importFingerprint,
          deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
        })),
        books.householdId,
        batchId,
      );
      if (victims.length > 0) {
        await tx.delete(transaction).where(
          and(
            eq(transaction.householdId, books.householdId),
            inArray(
              transaction.id,
              victims.map((row) => row.id),
            ),
          ),
        );
      }
      const undone = await tx
        .update(csvImport)
        .set({ undoneAt: new Date() })
        .where(and(eq(csvImport.id, batchId), eq(csvImport.householdId, books.householdId), isNull(csvImport.undoneAt)))
        .returning({ id: csvImport.id });
      if (undone.length === 0) throw new CsvImportError("That import was already undone.");
      return victims.length;
    });
    revalidateBooks();
    if (removed === 0) return { error: "", message: "That import had no transactions left to remove." };
    return { error: "", message: removedImportMessage(removed) };
  } catch (error) {
    logError(error, { action: "undo-csv-import", householdId: books.householdId });
    if (error instanceof DomainError) {
      return { error: memberFacingMessage(error, "Could not undo that import."), message: "" };
    }
    return { error: "Could not undo that import.", message: "" };
  }
}

export type CsvImportPanel = {
  open: OpenCsvImport[];
  undoneNotice: string;
};

export async function loadCsvImportPanel(): Promise<CsvImportPanel> {
  const books = await requireBooks();
  const rows = await withActor(books.userId, async (tx) => {
    const open = await tx
      .select({
        id: csvImport.id,
        addedCount: csvImport.addedCount,
        createdAt: csvImport.createdAt,
      })
      .from(csvImport)
      .where(and(eq(csvImport.householdId, books.householdId), isNull(csvImport.undoneAt)))
      .orderBy(desc(csvImport.createdAt))
      .limit(100);
    const [latest] = await tx
      .select({ addedCount: csvImport.addedCount, undoneAt: csvImport.undoneAt })
      .from(csvImport)
      .where(eq(csvImport.householdId, books.householdId))
      .orderBy(desc(csvImport.createdAt))
      .limit(1);
    return { open, latest: latest ?? null };
  });
  return {
    open: rows.open.map((row) => ({
      id: row.id,
      addedCount: row.addedCount,
      createdAt: row.createdAt.toISOString(),
    })),
    undoneNotice: rows.latest?.undoneAt ? removedImportMessage(rows.latest.addedCount) : "",
  };
}

function removedImportMessage(count: number): string {
  const label = count === 1 ? "transaction" : "transactions";
  return `Removed ${count} ${label} from that import. You can import that file again.`;
}

async function previewCsv(formData: FormData): Promise<ImportCsvState> {
  const books = await requireBooks();
  const file = await readCsvFile(formData);
  if ("error" in file) return { error: file.error, message: "", preview: null };

  try {
    const preview = await withActor(books.userId, async (tx) => {
      const context = await loadImportContext(tx, books.householdId);
      const outcome = await previewCsvImport(file.text, { rows: context.ledger }, (rows) =>
        resolveCsvRows(rows, context.accounts, context.categories, context.rules),
      );
      if (outcome.isErr()) throw outcome.error;
      return presentPreview(outcome.value, context.accounts, context.categories, file.stamp);
    });
    return { error: "", message: "", preview };
  } catch (error) {
    logError(error, { action: "preview-csv", householdId: books.householdId });
    return { error: importFailure(error), message: "", preview: null };
  }
}

async function commitCsv(formData: FormData): Promise<ImportCsvState> {
  const books = await requireBooks();
  const file = await readCsvFile(formData);
  if ("error" in file) return { error: file.error, message: "", preview: null };

  try {
    const inserted = await withActor(books.userId, async (tx) => {
      const context = await loadImportContext(tx, books.householdId);
      const outcome = await importCsv(file.text, { rows: context.ledger }, (rows) =>
        resolveCsvRows(rows, context.accounts, context.categories, context.rules),
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
      const [batch] = await tx
        .insert(csvImport)
        .values({ householdId: books.householdId, addedCount: drafts.length })
        .returning({ id: csvImport.id });
      if (!batch) throw new CsvImportError("Could not import that CSV.");

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
            importBatchId: batch.id,
          })),
        )
        .onConflictDoNothing({ target: [transaction.householdId, transaction.importFingerprint] })
        .returning({ id: transaction.id, fingerprint: transaction.importFingerprint });
      const idByFingerprint = new Map(
        saved.flatMap((row) => (row.fingerprint ? [[row.fingerprint, row.id] as const] : [])),
      );
      if (idByFingerprint.size === 0) {
        await tx
          .delete(csvImport)
          .where(and(eq(csvImport.id, batch.id), eq(csvImport.householdId, books.householdId)));
        return 0;
      }
      if (idByFingerprint.size !== drafts.length) {
        await tx
          .update(csvImport)
          .set({ addedCount: idByFingerprint.size })
          .where(and(eq(csvImport.id, batch.id), eq(csvImport.householdId, books.householdId)));
      }
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
    revalidateBooks();
    if (inserted === 0) {
      return { error: "", message: "That CSV was already imported. No new transactions.", preview: null };
    }
    const label = inserted === 1 ? "transaction" : "transactions";
    return { error: "", message: `Imported ${inserted} ${label}.`, preview: null };
  } catch (error) {
    logError(error, { action: "import-csv", householdId: books.householdId });
    return { error: importFailure(error), message: "", preview: null };
  }
}

function importFailure(error: unknown): string {
  if (error instanceof DomainError) return memberFacingMessage(error, "Could not import that CSV.");
  return "Could not import that CSV.";
}

async function readCsvFile(formData: FormData): Promise<{ error: string } | { text: string; stamp: string }> {
  const file = formData.get("csv");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file." };
  if (file.size > CSV_IMPORT_MAX_CHARS) return { error: csvTooLargeMessage() };
  const text = await file.text();
  const stamp = String(formData.get("stamp") ?? "").slice(0, 500);
  return { text, stamp };
}

async function loadImportContext(tx: AppTx, householdId: string) {
  const accountRows = await tx
    .select({
      id: ledgerAccount.id,
      name: ledgerAccount.name,
      householdId: ledgerAccount.householdId,
      archivedAt: ledgerAccount.archivedAt,
    })
    .from(ledgerAccount)
    .where(eq(ledgerAccount.householdId, householdId));
  const accounts = accountsForActiveLists(
    accountRows.map((row) => ({
      ...row,
      archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    })),
    householdId,
  ).map((row) => ({ id: row.id, name: row.name }));
  const categories = await tx
    .select({ id: category.id, name: category.name })
    .from(category)
    .where(eq(category.householdId, householdId));
  const existing = await tx
    .select({
      householdId: transaction.householdId,
      fingerprint: transaction.importFingerprint,
      deletedAt: transaction.deletedAt,
    })
    .from(transaction)
    .where(eq(transaction.householdId, householdId));
  // Deleted rows stay in this list. The same CSV row is not imported again.
  const rules: PayeeCategoryRule[] = await tx
    .select({ pattern: payeeCategoryRule.pattern, categoryId: payeeCategoryRule.categoryId })
    .from(payeeCategoryRule)
    .where(eq(payeeCategoryRule.householdId, householdId));
  return {
    accounts,
    categories,
    rules,
    ledger: retainedImportFingerprints(
      existing.map((row) => ({
        householdId: row.householdId,
        fingerprint: row.fingerprint,
        deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
      })),
      householdId,
    ),
  };
}

function presentPreview(
  outcome: CsvPreview<ResolvedCsvRow>,
  accounts: readonly { id: string; name: string }[],
  categories: readonly { id: string; name: string }[],
  stamp: string,
): ImportPreview {
  const accountName = new Map(accounts.map((account) => [account.id, account.name]));
  const categoryName = new Map(categories.map((item) => [item.id, item.name]));
  return {
    stamp,
    newCount: outcome.newCount,
    alreadyCount: outcome.alreadyCount,
    parsedRows: outcome.parsedRows,
    rows: outcome.rows.map((row) => ({
      line: row.line,
      occurredOn: row.occurredOn,
      payee: row.payee,
      amount: formatCents(row.amountCents),
      accountName: accountName.get(row.accountId) ?? row.accountName,
      categoryName: categoryName.get(row.categoryId) ?? row.categoryName,
      status: row.status,
    })),
  };
}

function revalidateBooks() {
  revalidatePath("/activity");
  revalidatePath("/");
  revalidatePath("/plan");
  revalidatePath("/history");
  revalidatePath("/projection");
}
