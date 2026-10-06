/**
 * A ledger row undo may consider. `importBatchId` is set only on rows a CSV
 * import created. Manual entries and bank sync leave it empty.
 */
export type ImportBatchTransaction = {
  id: string;
  householdId: string;
  importBatchId: string | null;
  importFingerprint: string | null;
  deletedAt: string | null;
};

/**
 * Rows to hard-delete when undoing one CSV import.
 *
 * Only rows whose batch id is this import are returned, including rows a
 * member already soft-deleted. Other imports, manual entries, and bank sync
 * rows stay, even when a bank fingerprint is `bank:{provider}:{id}`. Payee
 * category rules are not an input and are not changed.
 *
 * Hard-delete is the undo: the fingerprint leaves with the row, so importing
 * that file again adds those transactions as a new batch. A soft-deleted row
 * from a batch you do not undo still counts as already imported and does not
 * come back.
 */
export function transactionsRemovedByUndo(
  rows: readonly ImportBatchTransaction[],
  householdId: string,
  batchId: string,
): ImportBatchTransaction[] {
  const household = householdId.trim();
  const batch = batchId.trim();
  if (household.length === 0 || batch.length === 0) return [];
  return rows.filter((row) => row.householdId === household && row.importBatchId === batch);
}
