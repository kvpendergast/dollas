import { describe, expect, it } from "vitest";
import { retainedImportFingerprints } from "../activity/delete";
import { importCsv, previewCsvImport } from "./csv";
import { matchingPayeeRule, type PayeeCategoryRule } from "../rules/payee-category";
import { transactionsRemovedByUndo, type ImportBatchTransaction } from "./undo";

const maple = "maple-house";
const other = "other-house";
const stamp = "2026-10-05T23:40:00.000Z";
const batch = "batch-this-import";
const otherBatch = "batch-other-import";

const CSV = [
  "date,payee,amount,account,category",
  "2026-03-01,Northwind Payroll,3200.00,Checking,Paycheck",
  '2026-03-02,"Market, Downtown",-86.40,Checking,Groceries',
  '2026-03-02,"Market, Downtown",-86.40,Checking,Groceries',
].join("\n");

const rules: PayeeCategoryRule[] = [{ pattern: "Market", categoryId: "groceries" }];

function row(overrides: Partial<ImportBatchTransaction> & Pick<ImportBatchTransaction, "id">): ImportBatchTransaction {
  return {
    householdId: maple,
    importBatchId: null,
    importFingerprint: null,
    deletedAt: null,
    ...overrides,
  };
}

describe("undo one CSV import", () => {
  it("removes only the rows that import added", () => {
    const rows = [
      row({ id: "added", importBatchId: batch, importFingerprint: "abc:0" }),
      row({ id: "added-deleted", importBatchId: batch, importFingerprint: "abc:1", deletedAt: stamp }),
      row({ id: "other-import", importBatchId: otherBatch, importFingerprint: "def:0" }),
      row({ id: "manual" }),
      row({ id: "bank", importFingerprint: "bank:fake:txn-rent" }),
      row({ id: "foreign", householdId: other, importBatchId: batch, importFingerprint: "abc:0" }),
    ];

    const removed = transactionsRemovedByUndo(rows, maple, batch);
    expect(removed.map((item) => item.id)).toEqual(["added", "added-deleted"]);
    expect(matchingPayeeRule("Corner Market", rules)?.categoryId).toBe("groceries");
    expect(rules).toEqual([{ pattern: "Market", categoryId: "groceries" }]);
    expect(transactionsRemovedByUndo(rows, other, batch).map((item) => item.id)).toEqual(["foreign"]);
    expect(transactionsRemovedByUndo(rows, maple, otherBatch).map((item) => item.id)).toEqual(["other-import"]);
    expect(transactionsRemovedByUndo(rows, "  ", batch)).toEqual([]);
    expect(transactionsRemovedByUndo(rows, maple, "  ")).toEqual([]);
  });

  it("hard-deletes the batch so the same file can be imported again", async () => {
    const first = await importCsv(CSV, { rows: [] });
    if (first.isErr()) throw first.error;
    const stored = first.value.addedRows.map((item, index) =>
      row({
        id: `tx-${index}`,
        importBatchId: batch,
        importFingerprint: item.fingerprint,
        deletedAt: index === 1 ? stamp : null,
      }),
    );
    const kept = [
      row({ id: "manual" }),
      row({ id: "bank", importFingerprint: "bank:fake:txn-rent" }),
      row({ id: "other-import", importBatchId: otherBatch, importFingerprint: "def:0" }),
    ];
    const removed = transactionsRemovedByUndo([...kept, ...stored], maple, batch);
    expect(removed).toHaveLength(3);

    const ledger = retainedImportFingerprints(
      kept.map((item) => ({
        householdId: item.householdId,
        fingerprint: item.importFingerprint,
        deletedAt: item.deletedAt,
      })),
      maple,
    );
    expect(ledger.map((item) => item.fingerprint)).toEqual(["bank:fake:txn-rent", "def:0"]);

    const preview = await previewCsvImport(CSV, { rows: ledger });
    if (preview.isErr()) throw preview.error;
    expect(preview.value.newCount).toBe(3);
    expect(preview.value.alreadyCount).toBe(0);

    const again = await importCsv(CSV, { rows: ledger });
    if (again.isErr()) throw again.error;
    expect(again.value.added).toBe(3);
    expect(again.value.already).toBe(0);
  });

  it("leaves a soft-deleted row from another batch counted as already imported", async () => {
    const first = await importCsv(CSV, { rows: [] });
    if (first.isErr()) throw first.error;
    const fingerprint = first.value.addedRows[0]?.fingerprint;
    expect(fingerprint).toBeTruthy();
    const softDeleted = row({
      id: "kept-deleted",
      importBatchId: otherBatch,
      importFingerprint: fingerprint ?? null,
      deletedAt: stamp,
    });
    const undone = row({ id: "undone", importBatchId: batch, importFingerprint: "fff:0" });
    expect(transactionsRemovedByUndo([softDeleted, undone], maple, batch).map((item) => item.id)).toEqual(["undone"]);

    const ledger = retainedImportFingerprints(
      [
        {
          householdId: softDeleted.householdId,
          fingerprint: softDeleted.importFingerprint,
          deletedAt: softDeleted.deletedAt,
        },
      ],
      maple,
    );
    const preview = await previewCsvImport(CSV, { rows: ledger });
    if (preview.isErr()) throw preview.error;
    expect(preview.value.alreadyCount).toBe(1);
    expect(preview.value.newCount).toBe(2);
    expect(preview.value.rows[0]?.status).toBe("already");

    const again = await importCsv(CSV, { rows: ledger });
    if (again.isErr()) throw again.error;
    expect(again.value.added).toBe(2);
    expect(again.value.addedRows.some((item) => item.fingerprint === fingerprint)).toBe(false);
  });
});
