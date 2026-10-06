import type { ColumnMapping, SavedCsvMapping } from "./mapping";
import type { CommitCsvRow, MappedImportContext } from "./validate";

/** A mapping to remember for the next file with the same headers or account. */
export type MappingWrite = {
  headerSignature: string;
  accountId: string | null;
  mapping: ColumnMapping;
};

/**
 * One write for a mapped import: remember the mapping and insert the ready
 * rows. Implementations run this inside the household transaction. A throw
 * leaves the books unchanged.
 */
export type ImportWrite = {
  mapping: MappingWrite | null;
  rows: readonly CommitCsvRow[];
};

export type ImportWriteResult = {
  batchId: string | null;
  added: number;
};

/**
 * Household-scoped reads and the single import write.
 * Implementations run inside the app role transaction and throw on driver failure.
 * Callers show members a mapped sentence, not the thrown driver text.
 */
export type CsvImportStore = {
  loadContext(householdId: string): Promise<MappedImportContext & { savedMappings: readonly SavedCsvMapping[] }>;
  applyImport(householdId: string, write: ImportWrite): Promise<ImportWriteResult>;
};
