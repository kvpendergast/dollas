import { describe, expect, it } from "vitest";
import { importCsv, resolveCsvRows } from "./csv";

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
    expect(second.value.addedRows).toHaveLength(0);
    expect(first.value.addedRows).toHaveLength(first.value.parsedRows);
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
