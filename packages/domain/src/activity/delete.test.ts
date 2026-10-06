import { describe, expect, it } from "vitest";
import { importCsv } from "../import/csv";
import { matchingPayeeRule, type PayeeCategoryRule } from "../rules/payee-category";
import { deleteTransaction, restoreTransaction, retainedImportFingerprints } from "./delete";

const maple = "maple-house";
const other = "other-house";
const stamp = "2026-10-05T23:40:00.000Z";

const CSV = ["date,payee,amount,account,category", "2026-03-02,Corner Market,-12.00,Checking,Groceries"].join(
  "\n",
);

const rules: PayeeCategoryRule[] = [{ pattern: "Market", categoryId: "groceries" }];

describe("delete and restore a transaction", () => {
  it("hides the transaction and can put it back", () => {
    const stored = {
      id: "tx-1",
      householdId: maple,
      importFingerprint: "abc:0",
      deletedAt: null,
    };
    const deleted = deleteTransaction(stored, maple, stamp);
    expect(deleted.isOk()).toBe(true);
    if (deleted.isErr()) return;
    expect(deleted.value.deletedAt).toBe(stamp);
    expect(deleted.value.importFingerprint).toBe("abc:0");
    expect(deleteTransaction(deleted.value, maple, "2026-11-01T00:00:00.000Z")._unsafeUnwrap().deletedAt).toBe(
      stamp,
    );

    const restored = restoreTransaction(deleted.value, maple);
    expect(restored.isOk()).toBe(true);
    if (restored.isErr()) return;
    expect(restored.value.deletedAt).toBeNull();
    expect(restoreTransaction(restored.value, maple)._unsafeUnwrap().deletedAt).toBeNull();
  });

  it("does not delete or restore another household's transaction", () => {
    const stored = {
      id: "tx-1",
      householdId: maple,
      importFingerprint: "abc:0",
      deletedAt: null,
    };
    expect(deleteTransaction(stored, other, stamp).isErr()).toBe(true);
    expect(deleteTransaction(null, maple, stamp).isErr()).toBe(true);
    expect(deleteTransaction(stored, "  ", stamp).isErr()).toBe(true);
    expect(deleteTransaction(stored, maple, "  ").isErr()).toBe(true);
    expect(restoreTransaction({ ...stored, deletedAt: stamp }, other).isErr()).toBe(true);
    expect(restoreTransaction(null, maple).isErr()).toBe(true);
  });

  it("keeps a deleted CSV row from coming back and leaves payee rules alone", async () => {
    const first = await importCsv(CSV, { rows: [] });
    if (first.isErr()) throw first.error;
    const fingerprint = first.value.addedRows[0]?.fingerprint;
    expect(fingerprint).toBeTruthy();

    const deleted = deleteTransaction(
      {
        id: "tx-1",
        householdId: maple,
        importFingerprint: fingerprint ?? null,
        deletedAt: null,
      },
      maple,
      stamp,
    )._unsafeUnwrap();

    expect(matchingPayeeRule("Corner Market", rules)?.categoryId).toBe("groceries");
    expect(rules).toEqual([{ pattern: "Market", categoryId: "groceries" }]);

    const ledger = retainedImportFingerprints(
      [
        {
          householdId: deleted.householdId,
          fingerprint: deleted.importFingerprint,
          deletedAt: deleted.deletedAt,
        },
        { householdId: other, fingerprint: deleted.importFingerprint, deletedAt: stamp },
        { householdId: maple, fingerprint: null, deletedAt: null },
      ],
      maple,
    );
    expect(ledger).toEqual([{ fingerprint }]);

    const again = await importCsv(CSV, { rows: ledger });
    if (again.isErr()) throw again.error;
    expect(again.value.added).toBe(0);
    expect(again.value.parsedRows).toBe(1);

    const foreignOnly = retainedImportFingerprints(
      [{ householdId: other, fingerprint: deleted.importFingerprint, deletedAt: stamp }],
      maple,
    );
    expect(foreignOnly).toEqual([]);
    const imported = await importCsv(CSV, { rows: foreignOnly });
    if (imported.isErr()) throw imported.error;
    expect(imported.value.added).toBe(1);

    const restored = restoreTransaction(deleted, maple)._unsafeUnwrap();
    const stillThere = await importCsv(CSV, {
      rows: retainedImportFingerprints(
        [
          {
            householdId: restored.householdId,
            fingerprint: restored.importFingerprint,
            deletedAt: restored.deletedAt,
          },
        ],
        maple,
      ),
    });
    if (stillThere.isErr()) throw stillThere.error;
    expect(stillThere.value.added).toBe(0);
  });
});
