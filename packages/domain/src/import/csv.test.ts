import { describe, expect, it } from "vitest";
import { retainedImportFingerprints } from "../activity/delete";
import { CSV_IMPORT_MAX_CHARS, csvTooLargeMessage, importCsv, previewCsvImport, resolveCsvRows } from "./csv";

const CSV = [
  "date,payee,amount,account,category",
  "2026-03-01,Northwind Payroll,3200.00,Checking,Paycheck",
  '2026-03-02,"Market, Downtown",-86.40,Checking,Groceries',
  '2026-03-02,"Market, Downtown",-86.40,Checking,Groceries',
].join("\n");

describe("importCsv", () => {
  it("keeps one transaction per row when the same CSV is imported twice", async () => {
    const first = await importCsv(CSV, { rows: [] });
    if (first.isErr()) throw first.error;
    expect(first.value.parsedRows).toBe(3);
    expect(first.value.added).toBe(3);
    expect(first.value.addedRows).toHaveLength(3);
    expect(first.value.addedRows.map((row) => row.amountCents)).toEqual([320_000, -8_640, -8_640]);
    expect(first.value.addedRows.every((row) => Number.isInteger(row.amountCents))).toBe(true);
    expect(new Set(first.value.addedRows.map((row) => row.fingerprint)).size).toBe(3);

    const second = await importCsv(CSV, { rows: first.value.addedRows });
    if (second.isErr()) throw second.error;
    expect(second.value.added).toBe(0);
    expect(second.value.already).toBe(3);
    expect(second.value.addedRows).toHaveLength(0);
    expect(first.value.addedRows).toHaveLength(first.value.parsedRows);
  });

  it("importing the same file twice adds nothing", async () => {
    const first = await importCsv(CSV, { rows: [] });
    if (first.isErr()) throw first.error;
    const second = await importCsv(CSV, { rows: first.value.addedRows });
    if (second.isErr()) throw second.error;
    expect(second.value.added).toBe(0);
    expect(second.value.addedRows).toHaveLength(0);
    expect(second.value.parsedRows).toBe(first.value.parsedRows);

    const preview = await previewCsvImport(CSV, { rows: first.value.addedRows });
    if (preview.isErr()) throw preview.error;
    expect(preview.value.newCount).toBe(0);
    expect(preview.value.alreadyCount).toBe(3);
    expect(preview.value.rows.every((row) => row.status === "already")).toBe(true);
  });

  it("previews how many rows are new and how many are already in the books", async () => {
    const empty = await previewCsvImport(CSV, { rows: [] });
    if (empty.isErr()) throw empty.error;
    expect(empty.value.parsedRows).toBe(3);
    expect(empty.value.newCount).toBe(3);
    expect(empty.value.alreadyCount).toBe(0);
    expect(empty.value.rows.map((row) => row.status)).toEqual(["new", "new", "new"]);
    expect(empty.value.rows.map((row) => row.amountCents)).toEqual([320_000, -8_640, -8_640]);

    const known = retainedImportFingerprints(
      [
        {
          householdId: "maple",
          fingerprint: empty.value.rows[0]?.fingerprint ?? null,
          deletedAt: "2026-10-05T23:40:00.000Z",
        },
        {
          householdId: "other",
          fingerprint: empty.value.rows[1]?.fingerprint ?? null,
          deletedAt: null,
        },
      ],
      "maple",
    );
    const preview = await previewCsvImport(CSV, { rows: known });
    if (preview.isErr()) throw preview.error;
    expect(preview.value.alreadyCount).toBe(1);
    expect(preview.value.newCount).toBe(2);
    expect(preview.value.rows[0]?.status).toBe("already");
    expect(preview.value.rows.slice(1).every((row) => row.status === "new")).toBe(true);

    const imported = await importCsv(CSV, { rows: known });
    if (imported.isErr()) throw imported.error;
    expect(imported.value.added).toBe(2);
    expect(imported.value.already).toBe(1);
    expect(imported.value.addedRows.map((row) => row.fingerprint)).not.toContain(empty.value.rows[0]?.fingerprint);
  });

  it("states the size limit in plain words when the CSV is too large", async () => {
    const huge = "x".repeat(CSV_IMPORT_MAX_CHARS + 1);
    const result = await importCsv(huge, { rows: [] });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe(csvTooLargeMessage());
      expect(result.error.message).toBe("That CSV is too large. The limit is one million characters.");
      expect(result.error.message).not.toMatch(/MAX_|DATABASE_|process\.env/);
    }
    const preview = await previewCsvImport(huge, { rows: [] });
    expect(preview.isErr()).toBe(true);
    if (preview.isErr()) expect(preview.error.message).toBe("That CSV is too large. The limit is one million characters.");

    const atLimit = await importCsv("x".repeat(CSV_IMPORT_MAX_CHARS), { rows: [] });
    expect(atLimit.isErr()).toBe(true);
    if (atLimit.isErr()) expect(atLimit.error.message).not.toContain("too large");
  });

  it("treats a reordered, rewrapped copy of the same rows as the same file", async () => {
    const first = await importCsv(CSV, { rows: [] });
    if (first.isErr()) throw first.error;
    const variant = `\uFEFFAccount,Category,Amount,Payee,Date\r\nChecking,Paycheck,"$3,200.00",Northwind Payroll,2026-03-01\r\n\r\nChecking,Groceries,-86.4,"Market, Downtown",2026-03-02\r\nChecking,Groceries,-86.40,"Market, Downtown",2026-03-02\r\n`;
    const second = await importCsv(variant, { rows: first.value.addedRows });
    if (second.isErr()) throw second.error;
    expect(second.value.added).toBe(0);
    expect(second.value.addedRows).toHaveLength(0);
  });

  it("rejects amounts with more than two decimal places", async () => {
    const result = await importCsv(
      "date,payee,amount,account,category\n2026-01-01,Market,12.345,Checking,Groceries\n",
      { rows: [] },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe("csv_import");
  });

  it("resolves account and category names inside the household", () => {
    const rows = [
      {
        line: 2,
        occurredOn: "2026-03-02",
        payee: "Market",
        amountCents: -8_640,
        accountName: "checking",
        categoryName: "Groceries",
        fingerprint: "abc:0",
      },
    ];
    const resolved = resolveCsvRows(
      rows,
      [
        { id: "acct-1", name: "Checking" },
        { id: "acct-2", name: "Savings" },
      ],
      [{ id: "cat-1", name: "Groceries" }],
    );
    if (resolved.isErr()) throw resolved.error;
    expect(resolved.value[0]?.accountId).toBe("acct-1");
    expect(resolved.value[0]?.categoryId).toBe("cat-1");
    expect(resolved.value[0]?.fingerprint).toBe("abc:0");

    const missing = resolveCsvRows(rows, [{ id: "acct-2", name: "Savings" }], [{ id: "cat-1", name: "Groceries" }]);
    expect(missing.isErr()).toBe(true);
  });
});
