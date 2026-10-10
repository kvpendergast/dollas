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
  /** A bank sync has since linked this row to a bank charge (PEN-203). */
  bankBacked?: boolean;
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
 *
 * A row a bank sync has since linked to is not removed: the bank backs that
 * charge, and deleting it would only make the next sync add it back without
 * the member's edits. See {@link transactionsKeptByUndo}.
 */
export function transactionsRemovedByUndo(
  rows: readonly ImportBatchTransaction[],
  householdId: string,
  batchId: string,
): ImportBatchTransaction[] {
  return inBatch(rows, householdId, batchId).filter((row) => !row.bankBacked);
}

/**
 * Rows from this import that stay after undo because a bank sync linked them.
 * Undo detaches them from the batch (the batch id is cleared) and keeps the
 * fingerprint, so importing the same file again still shows them as duplicates.
 */
export function transactionsKeptByUndo(
  rows: readonly ImportBatchTransaction[],
  householdId: string,
  batchId: string,
): ImportBatchTransaction[] {
  return inBatch(rows, householdId, batchId).filter((row) => row.bankBacked === true);
}

function inBatch(rows: readonly ImportBatchTransaction[], householdId: string, batchId: string): ImportBatchTransaction[] {
  const household = householdId.trim();
  const batch = batchId.trim();
  if (household.length === 0 || batch.length === 0) return [];
  return rows.filter((row) => row.householdId === household && row.importBatchId === batch);
}
