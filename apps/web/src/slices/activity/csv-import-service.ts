import {
  CSV_IMPORT_MAX_CHARS,
  CsvImportError,
  commitMappedImport,
  csvTooLargeMessage,
  previewMappedImport,
  proposeCsvMapping,
  transactionsRemovedByUndo,
  type ColumnMapping,
  type CsvInspection,
  type MappedPreviewRow,
} from "@dollas/domain";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { withActor } from "@/db/actor";
import { csvImport, transaction } from "@/db/schema";
import { logInfo } from "@/lib/telemetry";
import { UUID, failure, refuse, succeed, type ServiceActor, type ServiceResult, type Via } from "@/lib/service-result";
import { csvImportStore } from "./csv-import-store";

/**
 * CSV import services (PEN-228) shared by the Activity import panel and MCP
 * tools: inspect and propose a mapping, validate with cell-level errors,
 * commit, undo, and list open imports. Nothing is written until commit.
 */

const FALLBACK = "Could not import that CSV.";

export type CsvPreviewRow = Pick<MappedPreviewRow, "line" | "status" | "amountCents" | "cells">;

export type CsvPreview = {
  readyCount: number;
  errorCount: number;
  duplicateCount: number;
  rows: CsvPreviewRow[];
};

export type CsvInspectOutcome = {
  inspection: CsvInspection;
  /** Present when a saved mapping for these headers was reused and validated. */
  preview: CsvPreview | null;
  /** Why the reused mapping did not validate, for the member to fix. */
  previewError: string;
};

export type CsvPreviewOutcome =
  | { kind: "preview"; inspection: CsvInspection; preview: CsvPreview }
  | { kind: "mapping_error"; inspection: CsvInspection; message: string };

export type CsvCommitOutcome = { batchId: string | null; added: number; errorCount: number; duplicateCount: number; message: string };

export type OpenCsvImport = { id: string; addedCount: number; createdAt: string };

export type CsvImportList = { open: OpenCsvImport[]; undoneNotice: string };

export function checkCsvText(csv: string): string | null {
  if (csv.length === 0) return "Choose a CSV file.";
  if (csv.length > CSV_IMPORT_MAX_CHARS) return csvTooLargeMessage();
  return null;
}

function presentable(outcome: { readyCount: number; errorCount: number; duplicateCount: number; rows: MappedPreviewRow[] }): CsvPreview {
  return {
    readyCount: outcome.readyCount,
    errorCount: outcome.errorCount,
    duplicateCount: outcome.duplicateCount,
    rows: outcome.rows.map((row) => ({ line: row.line, status: row.status, amountCents: row.amountCents, cells: row.cells })),
  };
}

function shownImportError(error: unknown): string {
  return error instanceof CsvImportError ? error.message : FALLBACK;
}

/** Reads the file, proposes a column mapping, and validates right away when a saved mapping fits. */
export async function inspectCsvImport(
  actor: ServiceActor,
  input: { csv: string; hasHeader?: boolean },
): Promise<ServiceResult<CsvInspectOutcome>> {
  const bad = checkCsvText(input.csv);
  if (bad) return refuse(bad);
  try {
    return succeed(
      await withActor(actor.userId, async (tx) => {
        const store = csvImportStore(tx);
        const proposed = await proposeCsvMapping(store, { householdId: actor.householdId, csv: input.csv, hasHeader: input.hasHeader });
        if (proposed.isErr()) throw proposed.error;
        if (!proposed.value.reusedSavedMapping) return { inspection: proposed.value, preview: null, previewError: "" };
        const validated = await previewMappedImport(store, { householdId: actor.householdId, csv: input.csv, mapping: proposed.value.mapping });
        if (validated.isErr()) return { inspection: proposed.value, preview: null, previewError: shownImportError(validated.error) };
        return { inspection: proposed.value, preview: presentable(validated.value), previewError: "" };
      }),
    );
  } catch (error) {
    return failure(error, FALLBACK, { action: "inspect-csv", householdId: actor.householdId });
  }
}

/** Validates every row against the mapping and reports cell-level errors. Nothing is written. */
export async function previewCsvImport(
  actor: ServiceActor,
  input: { csv: string; mapping: ColumnMapping },
): Promise<ServiceResult<CsvPreviewOutcome>> {
  const bad = checkCsvText(input.csv);
  if (bad) return refuse(bad);
  try {
    return succeed(
      await withActor(actor.userId, async (tx): Promise<CsvPreviewOutcome> => {
        const store = csvImportStore(tx);
        const proposed = await proposeCsvMapping(store, { householdId: actor.householdId, csv: input.csv, hasHeader: input.mapping.hasHeader });
        if (proposed.isErr()) throw proposed.error;
        const validated = await previewMappedImport(store, { householdId: actor.householdId, csv: input.csv, mapping: input.mapping });
        if (validated.isErr()) return { kind: "mapping_error", inspection: proposed.value, message: shownImportError(validated.error) };
        return { kind: "preview", inspection: proposed.value, preview: presentable(validated.value) };
      }),
    );
  } catch (error) {
    return failure(error, FALLBACK, { action: "preview-csv", householdId: actor.householdId });
  }
}

export function commitMessage(added: number, errorCount: number): string {
  if (added === 0 && errorCount === 0) return "That CSV was already imported. No new transactions.";
  if (added === 0) return "Nothing new to import. Those rows have errors or are already in the books.";
  const label = added === 1 ? "transaction" : "transactions";
  if (errorCount === 0) return `Imported ${added} ${label}.`;
  const skipped = errorCount === 1 ? "1 row with errors" : `${errorCount} rows with errors`;
  return `Imported ${added} ${label}. Skipped ${skipped}.`;
}

/** Writes the ready rows as one undoable import and remembers the mapping. Error and duplicate rows are skipped. */
export async function commitCsvImport(
  actor: ServiceActor,
  input: { csv: string; mapping: ColumnMapping },
  via: Via = "web",
): Promise<ServiceResult<CsvCommitOutcome>> {
  const bad = checkCsvText(input.csv);
  if (bad) return refuse(bad);
  try {
    const inserted = await withActor(actor.userId, async (tx) => {
      const outcome = await commitMappedImport(csvImportStore(tx), {
        householdId: actor.householdId,
        csv: input.csv,
        mapping: input.mapping,
        remember: true,
      });
      if (outcome.isErr()) throw outcome.error;
      return outcome.value;
    });
    logInfo("CSV imported", { action: "import-csv", via, householdId: actor.householdId, added: String(inserted.added) });
    return succeed({
      batchId: inserted.batchId,
      added: inserted.added,
      errorCount: inserted.errorCount,
      duplicateCount: inserted.duplicateCount,
      message: commitMessage(inserted.added, inserted.errorCount),
    });
  } catch (error) {
    return failure(error, FALLBACK, { action: "import-csv", via, householdId: actor.householdId });
  }
}

export function removedImportMessage(count: number): string {
  const label = count === 1 ? "transaction" : "transactions";
  return `Removed ${count} ${label} from that import. You can import that file again.`;
}

/** Removes the transactions an import added (except ones edited since) and marks it undone. */
export async function undoCsvImport(
  actor: ServiceActor,
  batchId: string,
  via: Via = "web",
): Promise<ServiceResult<{ removed: number; message: string }>> {
  if (!UUID.test(batchId)) return refuse("That import is not in this household.");
  try {
    const removed = await withActor(actor.userId, async (tx) => {
      const [batch] = await tx
        .select({ id: csvImport.id, undoneAt: csvImport.undoneAt })
        .from(csvImport)
        .where(and(eq(csvImport.id, batchId), eq(csvImport.householdId, actor.householdId)));
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
        .where(and(eq(transaction.householdId, actor.householdId), eq(transaction.importBatchId, batchId)));
      const victims = transactionsRemovedByUndo(
        candidates.map((row) => ({ ...row, deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null })),
        actor.householdId,
        batchId,
      );
      if (victims.length > 0) {
        await tx.delete(transaction).where(
          and(
            eq(transaction.householdId, actor.householdId),
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
        .where(and(eq(csvImport.id, batchId), eq(csvImport.householdId, actor.householdId), isNull(csvImport.undoneAt)))
        .returning({ id: csvImport.id });
      if (undone.length === 0) throw new CsvImportError("That import was already undone.");
      return victims.length;
    });
    logInfo("CSV import undone", { action: "undo-csv-import", via, householdId: actor.householdId, removed: String(removed) });
    const message = removed === 0 ? "That import had no transactions left to remove." : removedImportMessage(removed);
    return succeed({ removed, message });
  } catch (error) {
    return failure(error, "Could not undo that import.", { action: "undo-csv-import", via, householdId: actor.householdId });
  }
}

/** Imports that can still be undone, newest first, and a notice when the latest one was undone. */
export async function listCsvImports(actor: ServiceActor): Promise<ServiceResult<CsvImportList>> {
  try {
    const rows = await withActor(actor.userId, async (tx) => {
      const open = await tx
        .select({ id: csvImport.id, addedCount: csvImport.addedCount, createdAt: csvImport.createdAt })
        .from(csvImport)
        .where(and(eq(csvImport.householdId, actor.householdId), isNull(csvImport.undoneAt)))
        .orderBy(desc(csvImport.createdAt))
        .limit(100);
      const [latest] = await tx
        .select({ addedCount: csvImport.addedCount, undoneAt: csvImport.undoneAt })
        .from(csvImport)
        .where(eq(csvImport.householdId, actor.householdId))
        .orderBy(desc(csvImport.createdAt))
        .limit(1);
      return { open, latest: latest ?? null };
    });
    return succeed({
      open: rows.open.map((row) => ({ id: row.id, addedCount: row.addedCount, createdAt: row.createdAt.toISOString() })),
      undoneNotice: rows.latest?.undoneAt ? removedImportMessage(rows.latest.addedCount) : "",
    });
  } catch (error) {
    return failure(error, "Could not load imports.", { action: "list-csv-imports", householdId: actor.householdId });
  }
}
