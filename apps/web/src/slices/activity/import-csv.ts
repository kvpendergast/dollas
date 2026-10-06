"use server";

import {
  CSV_IMPORT_MAX_CHARS,
  CsvImportError,
  DomainError,
  commitMappedImport,
  csvTooLargeMessage,
  formatCents,
  memberFacingMessage,
  previewMappedImport,
  proposeCsvMapping,
  transactionsRemovedByUndo,
  type ColumnMapping,
  type CsvInspection,
  type DateOrder,
  type MappedPreviewRow,
} from "@dollas/domain";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withActor } from "@/db/actor";
import { csvImport, transaction } from "@/db/schema";
import { logError } from "@/lib/telemetry";
import { requireBooks } from "@/slices/access/guard";
import { csvImportStore } from "./csv-import-store";

const BATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ImportInspection = CsvInspection;

export type ImportPreviewCell = {
  field: string;
  text: string;
  message: string | null;
};

export type ImportPreviewRow = {
  line: number;
  status: "ready" | "error" | "duplicate";
  cells: ImportPreviewCell[];
};

export type ImportPreview = {
  stamp: string;
  readyCount: number;
  errorCount: number;
  duplicateCount: number;
  rows: ImportPreviewRow[];
};

export type ImportStage = "upload" | "map" | "preview";

export type ImportCsvState = {
  error: string;
  message: string;
  stage: ImportStage;
  stamp: string;
  inspection: ImportInspection | null;
  preview: ImportPreview | null;
};

export type UndoImportState = { error: string; message: string };

export type OpenCsvImport = {
  id: string;
  addedCount: number;
  createdAt: string;
};

const initialState: ImportCsvState = {
  error: "",
  message: "",
  stage: "upload",
  stamp: "",
  inspection: null,
  preview: null,
};

export async function importCsvAction(_state: ImportCsvState, formData: FormData): Promise<ImportCsvState> {
  const intent = String(formData.get("intent") ?? "inspect");
  if (intent === "commit") return commitCsv(formData);
  if (intent === "preview") return previewCsv(formData);
  return inspectCsv(formData);
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

async function inspectCsv(formData: FormData): Promise<ImportCsvState> {
  const books = await requireBooks();
  const file = await readCsvFile(formData);
  if ("error" in file) return { ...initialState, error: file.error, stamp: fileStamp(formData) };

  try {
    const inspection = await withActor(books.userId, async (tx) => {
      const store = csvImportStore(tx);
      const proposed = await proposeCsvMapping(store, {
        householdId: books.householdId,
        csv: file.text,
        hasHeader: headerChoice(formData),
      });
      if (proposed.isErr()) throw proposed.error;
      if (!proposed.value.reusedSavedMapping) return { inspection: proposed.value, preview: null as ImportPreview | null };
      const validated = await previewMappedImport(store, {
        householdId: books.householdId,
        csv: file.text,
        mapping: proposed.value.mapping,
      });
      if (validated.isErr()) return { inspection: proposed.value, preview: null, error: validated.error };
      return { inspection: proposed.value, preview: presentPreview(validated.value, file.stamp) };
    });
    if ("error" in inspection && inspection.error) {
      return {
        error: memberFacingMessage(inspection.error, "Could not import that CSV."),
        message: "",
        stage: "map",
        stamp: file.stamp,
        inspection: inspection.inspection,
        preview: null,
      };
    }
    return {
      error: "",
      message: "",
      stage: inspection.preview ? "preview" : "map",
      stamp: file.stamp,
      inspection: inspection.inspection,
      preview: inspection.preview,
    };
  } catch (error) {
    logError(error, { action: "inspect-csv", householdId: books.householdId });
    return { ...initialState, error: importFailure(error), stamp: file.stamp };
  }
}

async function previewCsv(formData: FormData): Promise<ImportCsvState> {
  const books = await requireBooks();
  const file = await readCsvFile(formData);
  if ("error" in file) return { ...initialState, error: file.error, stamp: fileStamp(formData) };
  const mapping = readMapping(formData);

  try {
    const view = await withActor(books.userId, async (tx) => {
      const store = csvImportStore(tx);
      const proposed = await proposeCsvMapping(store, {
        householdId: books.householdId,
        csv: file.text,
        hasHeader: mapping.hasHeader,
      });
      if (proposed.isErr()) throw proposed.error;
      const validated = await previewMappedImport(store, {
        householdId: books.householdId,
        csv: file.text,
        mapping,
      });
      if (validated.isErr()) return { inspection: proposed.value, error: validated.error };
      return { inspection: proposed.value, preview: presentPreview(validated.value, file.stamp) };
    });
    if ("error" in view) {
      return {
        error: memberFacingMessage(view.error, "Could not import that CSV."),
        message: "",
        stage: "map",
        stamp: file.stamp,
        inspection: view.inspection,
        preview: null,
      };
    }
    return { error: "", message: "", stage: "preview", stamp: file.stamp, inspection: view.inspection, preview: view.preview };
  } catch (error) {
    logError(error, { action: "preview-csv", householdId: books.householdId });
    return { ...initialState, error: importFailure(error), stamp: file.stamp };
  }
}

async function commitCsv(formData: FormData): Promise<ImportCsvState> {
  const books = await requireBooks();
  const file = await readCsvFile(formData);
  if ("error" in file) return { ...initialState, error: file.error, stamp: fileStamp(formData) };
  const mapping = readMapping(formData);

  try {
    const inserted = await withActor(books.userId, async (tx) => {
      const store = csvImportStore(tx);
      const outcome = await commitMappedImport(store, {
        householdId: books.householdId,
        csv: file.text,
        mapping,
        remember: true,
      });
      if (outcome.isErr()) throw outcome.error;
      return outcome.value;
    });
    revalidateBooks();
    return { ...initialState, message: commitMessage(inserted.added, inserted.errorCount), stamp: file.stamp };
  } catch (error) {
    logError(error, { action: "import-csv", householdId: books.householdId });
    return { ...initialState, error: importFailure(error), stamp: file.stamp };
  }
}

function commitMessage(added: number, errorCount: number): string {
  if (added === 0 && errorCount === 0) return "That CSV was already imported. No new transactions.";
  if (added === 0) return "Nothing new to import. Those rows have errors or are already in the books.";
  const label = added === 1 ? "transaction" : "transactions";
  if (errorCount === 0) return `Imported ${added} ${label}.`;
  const skipped = errorCount === 1 ? "1 row with errors" : `${errorCount} rows with errors`;
  return `Imported ${added} ${label}. Skipped ${skipped}.`;
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
  if (text.length > CSV_IMPORT_MAX_CHARS) return { error: csvTooLargeMessage() };
  return { text, stamp: fileStamp(formData) };
}

function fileStamp(formData: FormData): string {
  return String(formData.get("stamp") ?? "").slice(0, 500);
}

function headerChoice(formData: FormData): boolean | undefined {
  if (!formData.has("hasHeader")) return undefined;
  return formData.get("hasHeader") === "1";
}

function readMapping(formData: FormData): ColumnMapping {
  const dateOrderRaw = String(formData.get("dateOrder") ?? "");
  const fixedAccountId = String(formData.get("fixedAccountId") ?? "").trim();
  return {
    hasHeader: formData.get("hasHeader") === "1",
    dateColumn: optionalIndex(formData, "dateColumn"),
    payeeColumn: optionalIndex(formData, "payeeColumn"),
    amountMode: formData.get("amountMode") === "debit_credit" ? "debit_credit" : "signed",
    amountColumn: optionalIndex(formData, "amountColumn"),
    debitColumn: optionalIndex(formData, "debitColumn"),
    creditColumn: optionalIndex(formData, "creditColumn"),
    flipSign: formData.get("flipSign") === "1",
    dateOrder: isDateOrder(dateOrderRaw) ? dateOrderRaw : null,
    accountMode: formData.get("accountMode") === "column" ? "column" : "fixed",
    accountColumn: optionalIndex(formData, "accountColumn"),
    fixedAccountId: fixedAccountId.length > 0 ? fixedAccountId : null,
    categoryColumn: optionalIndex(formData, "categoryColumn"),
    notesColumn: optionalIndex(formData, "notesColumn"),
  };
}

function isDateOrder(value: string): value is DateOrder {
  return value === "ymd" || value === "mdy" || value === "dmy";
}

function optionalIndex(formData: FormData, name: string): number | null {
  const raw = String(formData.get(name) ?? "");
  if (raw.length === 0) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 63) return null;
  return value;
}

function presentPreview(
  outcome: { readyCount: number; errorCount: number; duplicateCount: number; rows: MappedPreviewRow[] },
  stamp: string,
): ImportPreview {
  return {
    stamp,
    readyCount: outcome.readyCount,
    errorCount: outcome.errorCount,
    duplicateCount: outcome.duplicateCount,
    rows: outcome.rows.map((row) => ({
      line: row.line,
      status: row.status,
      cells: row.cells.map((cell) => ({
        field: cell.field,
        text: cell.field === "amount" && row.amountCents != null && cell.message == null ? formatCents(row.amountCents) : cell.text,
        message: cell.message,
      })),
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
