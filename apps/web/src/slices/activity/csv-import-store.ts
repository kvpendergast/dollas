import {
  accountsForActiveLists,
  retainedImportFingerprints,
  validateSplits,
  type ColumnMapping,
  type CommitCsvRow,
  type CsvImportStore,
  type DateOrder,
  type ImportWrite,
  type SavedCsvMapping,
} from "@dollas/domain";
import { and, eq } from "drizzle-orm";
import type { AppTx } from "@/db/client";
import { category, csvColumnMapping, csvImport, ledgerAccount, payeeCategoryRule, transaction, transactionSplit } from "@/db/schema";

/**
 * Household import reads and the single commit write. The caller runs this
 * inside `withActor`, which is one transaction as dollas_app.
 */
export function csvImportStore(tx: AppTx): CsvImportStore {
  return {
    async loadContext(householdId) {
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
        .select({ id: category.id, name: category.name, kind: category.kind })
        .from(category)
        .where(eq(category.householdId, householdId));
      const rules = await tx
        .select({ pattern: payeeCategoryRule.pattern, categoryId: payeeCategoryRule.categoryId })
        .from(payeeCategoryRule)
        .where(eq(payeeCategoryRule.householdId, householdId));
      const existing = await tx
        .select({
          householdId: transaction.householdId,
          fingerprint: transaction.importFingerprint,
          deletedAt: transaction.deletedAt,
        })
        .from(transaction)
        .where(eq(transaction.householdId, householdId));
      const savedRows = await tx
        .select()
        .from(csvColumnMapping)
        .where(eq(csvColumnMapping.householdId, householdId));
      return {
        accounts,
        categories,
        rules,
        fingerprints: retainedImportFingerprints(
          existing.map((row) => ({
            householdId: row.householdId,
            fingerprint: row.fingerprint,
            deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
          })),
          householdId,
        ),
        savedMappings: savedRows.map((row) => toSavedMapping(row)),
      };
    },
    async applyImport(householdId, write) {
      if (write.mapping) await rememberMapping(tx, householdId, write.mapping);
      if (write.rows.length === 0) return { batchId: null, added: 0 };

      const categoryIds = new Map<string, string>();
      const resolved: {
        row: CommitCsvRow;
        categoryId: string;
        splits: { categoryId: string; amountCents: number }[];
      }[] = [];
      for (const row of write.rows) {
        const categoryId = await resolveCategory(tx, householdId, row.category, categoryIds);
        const balanced = validateSplits(row.amountCents, [{ categoryId, amountCents: row.amountCents }]);
        if (balanced.isErr()) throw balanced.error;
        resolved.push({ row, categoryId, splits: balanced.value });
      }

      const [batch] = await tx
        .insert(csvImport)
        .values({ householdId, addedCount: resolved.length })
        .returning({ id: csvImport.id });
      if (!batch) throw new Error("Could not import that CSV.");

      const saved = await tx
        .insert(transaction)
        .values(
          resolved.map((draft) => ({
            householdId,
            accountId: draft.row.accountId,
            occurredOn: draft.row.occurredOn,
            payee: draft.row.payee,
            amountCents: draft.row.amountCents,
            note: draft.row.note,
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
        await tx.delete(csvImport).where(and(eq(csvImport.id, batch.id), eq(csvImport.householdId, householdId)));
        return { batchId: null, added: 0 };
      }
      if (idByFingerprint.size !== resolved.length) {
        await tx
          .update(csvImport)
          .set({ addedCount: idByFingerprint.size })
          .where(and(eq(csvImport.id, batch.id), eq(csvImport.householdId, householdId)));
      }
      const splits = resolved.flatMap((draft) => {
        const transactionId = idByFingerprint.get(draft.row.fingerprint);
        if (!transactionId) return [];
        return draft.splits.map((split) => ({
          transactionId,
          householdId,
          categoryId: split.categoryId,
          amountCents: split.amountCents,
        }));
      });
      if (splits.length > 0) await tx.insert(transactionSplit).values(splits);
      return { batchId: batch.id, added: idByFingerprint.size };
    },
  };
}

async function rememberMapping(tx: AppTx, householdId: string, write: ImportWrite["mapping"]) {
  if (!write) return;
  const mapping = write.mapping;
  const values = {
    householdId,
    headerSignature: write.headerSignature,
    ledgerAccountId: write.accountId,
    hasHeader: mapping.hasHeader,
    dateColumn: mapping.dateColumn,
    payeeColumn: mapping.payeeColumn,
    amountMode: mapping.amountMode,
    amountColumn: mapping.amountColumn,
    debitColumn: mapping.debitColumn,
    creditColumn: mapping.creditColumn,
    flipSign: mapping.flipSign,
    dateOrder: mapping.dateOrder,
    accountMode: mapping.accountMode,
    accountColumn: mapping.accountColumn,
    categoryColumn: mapping.categoryColumn,
    notesColumn: mapping.notesColumn,
    updatedAt: new Date(),
  };
  await tx
    .insert(csvColumnMapping)
    .values(values)
    .onConflictDoUpdate({
      target: [csvColumnMapping.householdId, csvColumnMapping.headerSignature],
      set: values,
    });
}

async function resolveCategory(
  tx: AppTx,
  householdId: string,
  choice: { kind: "id"; id: string } | { kind: "fallback"; fallback: "income" | "expense" },
  cache: Map<string, string>,
): Promise<string> {
  if (choice.kind === "id") return choice.id;
  const cached = cache.get(choice.fallback);
  if (cached) return cached;
  const name = choice.fallback === "income" ? "Uncategorized income" : "Uncategorized";
  const [existing] = await tx
    .select({ id: category.id })
    .from(category)
    .where(and(eq(category.householdId, householdId), eq(category.kind, choice.fallback), eq(category.name, name)));
  if (existing) {
    cache.set(choice.fallback, existing.id);
    return existing.id;
  }
  const [created] = await tx
    .insert(category)
    .values({ householdId, name, kind: choice.fallback, sortOrder: 1000 })
    .returning({ id: category.id });
  if (!created) throw new Error("Could not import that CSV.");
  cache.set(choice.fallback, created.id);
  return created.id;
}

function toSavedMapping(row: typeof csvColumnMapping.$inferSelect): SavedCsvMapping {
  const mapping: ColumnMapping = {
    hasHeader: row.hasHeader,
    dateColumn: row.dateColumn,
    payeeColumn: row.payeeColumn,
    amountMode: row.amountMode === "debit_credit" ? "debit_credit" : "signed",
    amountColumn: row.amountColumn,
    debitColumn: row.debitColumn,
    creditColumn: row.creditColumn,
    flipSign: row.flipSign,
    dateOrder: dateOrder(row.dateOrder),
    accountMode: row.accountMode === "column" ? "column" : "fixed",
    accountColumn: row.accountColumn,
    fixedAccountId: row.accountMode === "fixed" ? row.ledgerAccountId : null,
    categoryColumn: row.categoryColumn,
    notesColumn: row.notesColumn,
  };
  return {
    id: row.id,
    householdId: row.householdId,
    headerSignature: row.headerSignature,
    accountId: row.ledgerAccountId,
    mapping,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function dateOrder(value: string | null): DateOrder | null {
  if (value === "ymd" || value === "mdy" || value === "dmy") return value;
  return null;
}
