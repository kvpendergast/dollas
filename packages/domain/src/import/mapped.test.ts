import { describe, expect, it } from "vitest";
import { retainedImportFingerprints } from "../activity/delete";
import { importCsv } from "./csv";
import { inspectCsvImport, parseCsvAmount, readCsvDate } from "./mapping";
import { commitMappedImport, previewMappedImport, proposeCsvMapping } from "./service";
import type { CsvImportStore } from "./store";
import { transactionsRemovedByUndo, type ImportBatchTransaction } from "./undo";
import { validateMappedImport, type CommitCsvRow, type MappedImportContext } from "./validate";

const maple = "maple-house";
const accounts = [
  { id: "acct-checking", name: "Checking" },
  { id: "acct-visa", name: "Visa" },
];
const categories = [
  { id: "cat-paycheck", name: "Paycheck", kind: "income" },
  { id: "cat-groceries", name: "Groceries", kind: "expense" },
  { id: "cat-uncat", name: "Uncategorized", kind: "expense" },
];

const classic = [
  "date,payee,amount,account,category",
  "2026-03-01,Northwind Payroll,3200.00,Checking,Paycheck",
  '2026-03-02,"Market, Downtown",-86.40,Checking,Groceries',
  '2026-03-02,"Market, Downtown",-86.40,Checking,Groceries',
].join("\n");

function context(overrides: Partial<MappedImportContext> = {}): MappedImportContext {
  return {
    accounts,
    categories,
    rules: [],
    fingerprints: [],
    ...overrides,
  };
}

type MemoryState = {
  fail: boolean;
  mappings: CsvImportStore extends never ? never : {
    id: string;
    householdId: string;
    headerSignature: string;
    accountId: string | null;
    mapping: import("./mapping").ColumnMapping;
    updatedAt: string;
  }[];
  committed: { batchId: string; rows: CommitCsvRow[] }[];
  fingerprints: { fingerprint: string }[];
};

function memoryStore(seed: Partial<MemoryState> = {}): CsvImportStore & { state: MemoryState } {
  const state: MemoryState = {
    fail: false,
    mappings: [],
    committed: [],
    fingerprints: [],
    ...seed,
  };
  return {
    state,
    async loadContext() {
      return {
        ...context(),
        fingerprints: state.fingerprints,
        savedMappings: state.mappings,
      };
    },
    async applyImport(_householdId, write) {
      if (state.fail) throw new Error("database unavailable");
      const batchId = write.rows.length > 0 ? `batch-${state.committed.length + 1}` : null;
      if (write.mapping) {
        state.mappings = [
          ...state.mappings.filter((row) => row.headerSignature !== write.mapping?.headerSignature),
          {
            id: `map-${state.mappings.length + 1}`,
            householdId: maple,
            headerSignature: write.mapping.headerSignature,
            accountId: write.mapping.accountId,
            mapping: write.mapping.mapping,
            updatedAt: "2026-10-06T00:00:00.000Z",
          },
        ];
      }
      if (batchId) {
        state.committed.push({ batchId, rows: [...write.rows] });
        state.fingerprints = [
          ...state.fingerprints,
          ...write.rows.map((row) => ({ fingerprint: row.fingerprint })),
        ];
      }
      return { batchId, added: write.rows.length };
    },
  };
}

describe("column mapping", () => {
  it("guesses common bank headers", async () => {
    const csv = [
      "Transaction Date,Merchant,Amount,Account Name,Category,Memo,Balance",
      "2026-03-02,Market,-86.40,Checking,Groceries,weekly,100.00",
    ].join("\n");
    const inspected = await inspectCsvImport(csv);
    if (inspected.isErr()) throw inspected.error;
    expect(inspected.value.hasHeader).toBe(true);
    expect(inspected.value.mapping.dateColumn).toBe(0);
    expect(inspected.value.mapping.payeeColumn).toBe(1);
    expect(inspected.value.mapping.amountMode).toBe("signed");
    expect(inspected.value.mapping.amountColumn).toBe(2);
    expect(inspected.value.mapping.accountMode).toBe("column");
    expect(inspected.value.mapping.accountColumn).toBe(3);
    expect(inspected.value.mapping.categoryColumn).toBe(4);
    expect(inspected.value.mapping.notesColumn).toBe(5);
    expect(inspected.value.mapping.flipSign).toBe(false);
    expect(inspected.value.dateOrderAmbiguous).toBe(false);
    expect(inspected.value.columns.map((column) => column.label)).toContain("Balance");
    expect(inspected.value.sampleRows[0]?.[1]).toBe("Market");

    const posted = await inspectCsvImport("Posted,Description,Debit,Credit\n03/13/2026,Cafe,4.00,\n");
    if (posted.isErr()) throw posted.error;
    expect(posted.value.mapping.dateColumn).toBe(0);
    expect(posted.value.mapping.payeeColumn).toBe(1);
    expect(posted.value.mapping.amountMode).toBe("debit_credit");
    expect(posted.value.mapping.debitColumn).toBe(2);
    expect(posted.value.mapping.creditColumn).toBe(3);
    expect(posted.value.mapping.dateOrder).toBe("mdy");
  });

  it("reads debit and credit, and can flip the sign", async () => {
    const csv = ["Posted,Description,Debit,Credit", "03/13/2026,Market,86.40,", '03/14/2026,Payroll,,"3,200.00"'].join(
      "\n",
    );
    const inspected = await inspectCsvImport(csv);
    if (inspected.isErr()) throw inspected.error;
    const mapping = {
      ...inspected.value.mapping,
      accountMode: "fixed" as const,
      fixedAccountId: "acct-checking",
    };
    const plain = await validateMappedImport(csv, mapping, context());
    if (plain.isErr()) throw plain.error;
    expect(plain.value.ready.map((row) => row.amountCents)).toEqual([-8_640, 320_000]);

    const flipped = await validateMappedImport(csv, { ...mapping, flipSign: true }, context());
    if (flipped.isErr()) throw flipped.error;
    expect(flipped.value.ready.map((row) => row.amountCents)).toEqual([8_640, -320_000]);
  });

  it("asks for an order when dates could be month-first or day-first", async () => {
    const csv = ["Date,Description,Amount", "01/02/2026,Market,-1.00", "03/04/2026,Cafe,-2.00"].join("\n");
    const inspected = await inspectCsvImport(csv);
    if (inspected.isErr()) throw inspected.error;
    expect(inspected.value.dateOrderAmbiguous).toBe(true);
    expect(inspected.value.mapping.dateOrder).toBeNull();
    const mapping = {
      ...inspected.value.mapping,
      accountMode: "fixed" as const,
      fixedAccountId: "acct-checking",
    };
    const missing = await validateMappedImport(csv, mapping, context());
    expect(missing.isErr()).toBe(true);
    if (missing.isErr()) expect(missing.error.message).toBe("Choose whether dates start with the month or the day.");

    const monthFirst = await validateMappedImport(csv, { ...mapping, dateOrder: "mdy" }, context());
    if (monthFirst.isErr()) throw monthFirst.error;
    expect(monthFirst.value.ready.map((row) => row.occurredOn)).toEqual(["2026-01-02", "2026-03-04"]);

    const dayFirst = await validateMappedImport(csv, { ...mapping, dateOrder: "dmy" }, context());
    if (dayFirst.isErr()) throw dayFirst.error;
    expect(dayFirst.value.ready.map((row) => row.occurredOn)).toEqual(["2026-02-01", "2026-04-03"]);

    expect(readCsvDate("13/01/2026", null)).toEqual({ ok: true, iso: "2026-01-13", order: "dmy" });
    expect(readCsvDate("01/13/2026", null)).toEqual({ ok: true, iso: "2026-01-13", order: "mdy" });
    expect(readCsvDate("01/02/2026", "ymd")).toEqual({ ok: false, reason: "invalid" });
    expect(readCsvDate("13/45/2026", "mdy")).toEqual({ ok: false, reason: "invalid" });
    expect(readCsvDate("13/01/2026", "mdy")).toEqual({ ok: false, reason: "invalid" });
  });

  it("accepts parentheses, currency symbols, and thousands separators", () => {
    expect(parseCsvAmount("($1,234.56)")).toEqual({ ok: true, cents: -123_456 });
    expect(parseCsvAmount("(86.40)")).toEqual({ ok: true, cents: -8_640 });
    expect(parseCsvAmount("$3,200.00")).toEqual({ ok: true, cents: 320_000 });
    expect(parseCsvAmount("USD 12.50")).toEqual({ ok: true, cents: 1_250 });
    expect(parseCsvAmount("twelve")).toEqual({ ok: false, reason: "not_number" });
    expect(parseCsvAmount("12.345")).toEqual({ ok: false, reason: "precision" });
  });

  it("treats a file with no header row as data", async () => {
    const csv = "2026-03-02,Market,-86.40\n2026-03-03,Cafe,(4.00)\n";
    const inspected = await inspectCsvImport(csv);
    if (inspected.isErr()) throw inspected.error;
    expect(inspected.value.hasHeader).toBe(false);
    expect(inspected.value.headerRow).toBeNull();
    expect(inspected.value.columns.map((column) => column.label)).toEqual(["Column 1", "Column 2", "Column 3"]);
    expect(inspected.value.sampleRows[0]).toEqual(["2026-03-02", "Market", "-86.40"]);
    const validated = await validateMappedImport(
      csv,
      {
        ...inspected.value.mapping,
        dateColumn: 0,
        payeeColumn: 1,
        amountMode: "signed",
        amountColumn: 2,
        dateOrder: "ymd",
        accountMode: "fixed",
        fixedAccountId: "acct-checking",
      },
      context(),
    );
    if (validated.isErr()) throw validated.error;
    expect(validated.value.readyCount).toBe(2);
    expect(validated.value.ready.map((row) => row.amountCents)).toEqual([-8_640, -400]);
    expect(validated.value.ready[0]?.category.kind).toBe("id");
    expect(validated.value.ready[0]?.categoryName).toBe("Uncategorized");
  });
});

describe("cell errors and commit", () => {
  it("names the row, the field, and the bad value", async () => {
    const lines = ["Date,Description,Amount,Account,Category"];
    for (let index = 0; index < 12; index += 1) {
      lines.push("2026-03-01,Shop,1.00,Checking,Groceries");
    }
    lines.push("13/45/2026,Cafe,twelve,Missing,Nope");
    const csv = lines.join("\n");
    const inspected = await inspectCsvImport(csv);
    if (inspected.isErr()) throw inspected.error;
    const validated = await validateMappedImport(csv, inspected.value.mapping, context());
    if (validated.isErr()) throw validated.error;
    const bad = validated.value.rows[12];
    expect(bad?.line).toBe(14);
    expect(bad?.status).toBe("error");
    expect(bad?.cells.find((cell) => cell.field === "date")?.message).toBe("Row 14, Date: '13/45/2026' isn't a date");
    expect(bad?.cells.find((cell) => cell.field === "amount")?.message).toBe("Row 14, Amount: 'twelve' isn't a number");
    expect(bad?.cells.find((cell) => cell.field === "account")?.message).toBe(
      'Row 14, Account: No account named "Missing".',
    );
    expect(bad?.cells.find((cell) => cell.field === "category")?.message).toBe(
      'Row 14, Category: No category named "Nope".',
    );
    expect(validated.value.readyCount).toBe(12);
    expect(validated.value.errorCount).toBe(1);
  });

  it("imports the ready rows in one write and leaves error rows out", async () => {
    const csv = [
      "Date,Description,Amount",
      "2026-03-02,Market,-86.40",
      "2026-03-03,Cafe,twelve",
      "2026-03-04,Payroll,3200.00",
    ].join("\n");
    const store = memoryStore();
    const proposed = await proposeCsvMapping(store, { householdId: maple, csv });
    if (proposed.isErr()) throw proposed.error;
    const mapping = {
      ...proposed.value.mapping,
      accountMode: "fixed" as const,
      fixedAccountId: "acct-checking",
      dateOrder: "ymd" as const,
    };
    const preview = await previewMappedImport(store, { householdId: maple, csv, mapping });
    if (preview.isErr()) throw preview.error;
    expect(preview.value.readyCount).toBe(2);
    expect(preview.value.errorCount).toBe(1);
    expect(preview.value.duplicateCount).toBe(0);

    store.state.fail = true;
    await expect(commitMappedImport(store, { householdId: maple, csv, mapping, remember: true })).rejects.toThrow(
      "database unavailable",
    );
    expect(store.state.committed).toEqual([]);
    expect(store.state.mappings).toEqual([]);

    store.state.fail = false;
    const committed = await commitMappedImport(store, { householdId: maple, csv, mapping, remember: true });
    if (committed.isErr()) throw committed.error;
    expect(committed.value.added).toBe(2);
    expect(committed.value.errorCount).toBe(1);
    expect(store.state.committed).toHaveLength(1);
    expect(store.state.committed[0]?.rows.map((row) => row.payee)).toEqual(["Market", "Payroll"]);
    expect(store.state.committed[0]?.rows.some((row) => row.payee === "Cafe")).toBe(false);
  });

  it("reuses a saved mapping, including an edit", async () => {
    const csv = ["Transaction Date,Merchant,Amount", "2026-04-01,Market,-10.00"].join("\n");
    const store = memoryStore();
    const first = await proposeCsvMapping(store, { householdId: maple, csv });
    if (first.isErr()) throw first.error;
    expect(first.value.reusedSavedMapping).toBe(false);
    const mapping = { ...first.value.mapping, accountMode: "fixed" as const, fixedAccountId: "acct-checking" };
    const saved = await commitMappedImport(store, { householdId: maple, csv, mapping, remember: true });
    if (saved.isErr()) throw saved.error;
    expect(saved.value.added).toBe(1);

    const again = await proposeCsvMapping(store, { householdId: maple, csv });
    if (again.isErr()) throw again.error;
    expect(again.value.reusedSavedMapping).toBe(true);
    expect(again.value.mapping.dateColumn).toBe(mapping.dateColumn);
    expect(again.value.mapping.payeeColumn).toBe(mapping.payeeColumn);
    expect(again.value.mapping.amountColumn).toBe(mapping.amountColumn);
    expect(again.value.mapping.fixedAccountId).toBe("acct-checking");
    expect(again.value.mapping.flipSign).toBe(false);

    const edited = { ...again.value.mapping, flipSign: true };
    const rewritten = await commitMappedImport(store, { householdId: maple, csv, mapping: edited, remember: true });
    if (rewritten.isErr()) throw rewritten.error;
    expect(rewritten.value.added).toBe(1);
    const editedProposal = await proposeCsvMapping(store, { householdId: maple, csv });
    if (editedProposal.isErr()) throw editedProposal.error;
    expect(editedProposal.value.mapping.flipSign).toBe(true);
  });

  it("adds nothing when the same file is imported again with the same mapping", async () => {
    const store = memoryStore();
    const inspected = await inspectCsvImport(classic);
    if (inspected.isErr()) throw inspected.error;
    const first = await commitMappedImport(store, {
      householdId: maple,
      csv: classic,
      mapping: inspected.value.mapping,
      remember: true,
    });
    if (first.isErr()) throw first.error;
    expect(first.value.added).toBe(3);

    const second = await commitMappedImport(store, {
      householdId: maple,
      csv: classic,
      mapping: inspected.value.mapping,
      remember: true,
    });
    if (second.isErr()) throw second.error;
    expect(second.value.added).toBe(0);
    expect(second.value.duplicateCount).toBe(3);
    expect(second.value.readyCount).toBe(0);
    expect(store.state.committed).toHaveLength(1);

    const legacy = await importCsv(classic, { rows: [] });
    if (legacy.isErr()) throw legacy.error;
    expect(first.value.readyCount).toBe(3);
    expect(store.state.committed[0]?.rows.map((row) => row.fingerprint)).toEqual(
      legacy.value.addedRows.map((row) => row.fingerprint),
    );
  });

  it("keeps a soft-deleted row deleted", async () => {
    const legacy = await importCsv(classic, { rows: [] });
    if (legacy.isErr()) throw legacy.error;
    const deleted = retainedImportFingerprints(
      [
        {
          householdId: maple,
          fingerprint: legacy.value.addedRows[0]?.fingerprint ?? null,
          deletedAt: "2026-10-05T23:40:00.000Z",
        },
      ],
      maple,
    );
    const inspected = await inspectCsvImport(classic);
    if (inspected.isErr()) throw inspected.error;
    const preview = await validateMappedImport(classic, inspected.value.mapping, context({ fingerprints: deleted }));
    if (preview.isErr()) throw preview.error;
    expect(preview.value.duplicateCount).toBe(1);
    expect(preview.value.readyCount).toBe(2);
    expect(preview.value.rows[0]?.status).toBe("duplicate");

    const store = memoryStore({ fingerprints: deleted });
    const committed = await commitMappedImport(store, {
      householdId: maple,
      csv: classic,
      mapping: inspected.value.mapping,
      remember: false,
    });
    if (committed.isErr()) throw committed.error;
    expect(committed.value.added).toBe(2);
    expect(store.state.committed[0]?.rows.map((row) => row.fingerprint)).not.toContain(
      legacy.value.addedRows[0]?.fingerprint,
    );
  });

  it("undo removes only the batch this import wrote", async () => {
    const store = memoryStore();
    const inspected = await inspectCsvImport(classic);
    if (inspected.isErr()) throw inspected.error;
    const committed = await commitMappedImport(store, {
      householdId: maple,
      csv: classic,
      mapping: inspected.value.mapping,
      remember: false,
    });
    if (committed.isErr()) throw committed.error;
    const batchId = committed.value.batchId ?? "";
    const rows: ImportBatchTransaction[] = [
      ...store.state.committed[0]!.rows.map((row, index) => ({
        id: `added-${index}`,
        householdId: maple,
        importBatchId: batchId,
        importFingerprint: row.fingerprint,
        deletedAt: index === 1 ? "2026-10-05T23:40:00.000Z" : null,
      })),
      {
        id: "other-import",
        householdId: maple,
        importBatchId: "batch-other",
        importFingerprint: "def:0",
        deletedAt: null,
      },
      { id: "manual", householdId: maple, importBatchId: null, importFingerprint: null, deletedAt: null },
      { id: "bank", householdId: maple, importBatchId: null, importFingerprint: "bank:fake:txn-rent", deletedAt: null },
    ];
    expect(transactionsRemovedByUndo(rows, maple, batchId).map((row) => row.id)).toEqual([
      "added-0",
      "added-1",
      "added-2",
    ]);
    expect(transactionsRemovedByUndo(rows, maple, "batch-other").map((row) => row.id)).toEqual(["other-import"]);
  });
});
