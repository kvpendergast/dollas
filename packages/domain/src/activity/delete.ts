import { err, ok, type Result } from "neverthrow";
import { TransactionError } from "../errors";

/**
 * A transaction the household can delete or restore.
 * `importFingerprint` stays on the row after delete so CSV import can see it.
 */
export type StoredTransaction = {
  id: string;
  householdId: string;
  importFingerprint: string | null;
  deletedAt: string | null;
};

/**
 * Hide a transaction from the books. The row stays, including its import
 * fingerprint, so importing the same CSV does not bring it back.
 * Payee category rules are not an input and are not changed.
 */
export function deleteTransaction(
  transaction: StoredTransaction | null,
  householdId: string,
  deletedAt: string,
): Result<StoredTransaction, TransactionError> {
  const owned = requireOwned(transaction, householdId);
  if (owned.isErr()) return err(owned.error);
  if (owned.value.deletedAt !== null) return ok(owned.value);
  const stamp = deletedAt.trim();
  if (stamp.length === 0) return err(new TransactionError("Could not delete that transaction."));
  return ok({ ...owned.value, deletedAt: stamp });
}

/** Put a deleted transaction back. A transaction that is already visible stays as it is. */
export function restoreTransaction(
  transaction: StoredTransaction | null,
  householdId: string,
): Result<StoredTransaction, TransactionError> {
  const owned = requireOwned(transaction, householdId);
  if (owned.isErr()) return err(owned.error);
  if (owned.value.deletedAt === null) return ok(owned.value);
  return ok({ ...owned.value, deletedAt: null });
}

/**
 * Fingerprints that still count as imported for this household.
 * Deleted rows are included on purpose: re-importing that CSV row does not
 * recreate the transaction. Rows from another household are left out.
 * Payee rules are not consulted.
 */
export function retainedImportFingerprints(
  rows: readonly {
    householdId: string;
    fingerprint: string | null;
    deletedAt: string | null;
  }[],
  householdId: string,
): { fingerprint: string }[] {
  if (householdId.trim().length === 0) return [];
  const seen = new Set<string>();
  const kept: { fingerprint: string }[] = [];
  for (const row of rows) {
    if (row.householdId !== householdId || row.fingerprint == null || row.fingerprint.length === 0) {
      continue;
    }
    if (seen.has(row.fingerprint)) continue;
    seen.add(row.fingerprint);
    kept.push({ fingerprint: row.fingerprint });
  }
  return kept;
}

function requireOwned(
  transaction: StoredTransaction | null,
  householdId: string,
): Result<StoredTransaction, TransactionError> {
  if (!transaction || transaction.householdId !== householdId || householdId.trim().length === 0) {
    return err(new TransactionError("That transaction is not in this household."));
  }
  return ok(transaction);
}
