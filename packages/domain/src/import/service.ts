import { err, ok, type Result } from "neverthrow";
import { CsvImportError } from "../errors";
import { inspectCsvImport, mappingSignature, type ColumnMapping, type CsvInspection } from "./mapping";
import type { CsvImportStore, ImportWriteResult } from "./store";
import { validateMappedImport, type MappedValidation } from "./validate";

export type CommitMappedImportResult = ImportWriteResult & {
  readyCount: number;
  errorCount: number;
  duplicateCount: number;
};

/**
 * Parse a CSV, propose a column mapping, and reuse a saved mapping when the
 * header signature (or the single saved account mapping for a no-header file)
 * matches. Pages and a future MCP tool call this before asking the member.
 */
export async function proposeCsvMapping(
  store: CsvImportStore,
  input: { householdId: string; csv: string; hasHeader?: boolean },
): Promise<Result<CsvInspection, CsvImportError>> {
  const context = await store.loadContext(input.householdId);
  return inspectCsvImport(input.csv, { savedMappings: context.savedMappings, hasHeader: input.hasHeader });
}

/**
 * Validate every row with the shared mapped-transaction schema.
 * Returns cell-level errors and the ready, error, and duplicate counts.
 * Nothing is written.
 */
export async function previewMappedImport(
  store: CsvImportStore,
  input: { householdId: string; csv: string; mapping: ColumnMapping },
): Promise<Result<MappedValidation, CsvImportError>> {
  const context = await store.loadContext(input.householdId);
  return validateMappedImport(input.csv, input.mapping, context);
}

/**
 * Write one import. Error rows are left out. Ready rows and the saved mapping
 * go through a single store write, so a failure leaves nothing behind.
 * Duplicate fingerprints, including soft-deleted rows, are not inserted.
 */
export async function commitMappedImport(
  store: CsvImportStore,
  input: { householdId: string; csv: string; mapping: ColumnMapping; remember: boolean },
): Promise<Result<CommitMappedImportResult, CsvImportError>> {
  const context = await store.loadContext(input.householdId);
  const validated = await validateMappedImport(input.csv, input.mapping, context);
  if (validated.isErr()) return err(validated.error);
  const counts = {
    readyCount: validated.value.readyCount,
    errorCount: validated.value.errorCount,
    duplicateCount: validated.value.duplicateCount,
  };
  const mapping = input.remember
    ? {
        headerSignature: mappingSignature(validated.value.headerSignature, input.mapping),
        accountId: input.mapping.accountMode === "fixed" ? input.mapping.fixedAccountId : null,
        mapping: input.mapping,
      }
    : null;
  if (validated.value.ready.length === 0 && !mapping) {
    return ok({ batchId: null, added: 0, ...counts });
  }
  const applied = await store.applyImport(input.householdId, {
    mapping,
    rows: validated.value.ready,
  });
  return ok({ ...applied, ...counts });
}
