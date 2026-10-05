import { err, ok, type Result } from "neverthrow";
import { CsvImportError } from "../errors";
import { parseDollarInput, type Cents } from "../money/cents";
import { matchingPayeeRule, type PayeeCategoryRule } from "../rules/payee-category";

const MAX_CSV_CHARS = 1_000_000;
const MAX_ROWS = 5_000;
const MAX_COLUMNS = 20;
const MAX_PAYEE = 200;

const COLUMNS = ["date", "payee", "amount", "account", "category"] as const;

type ColumnName = (typeof COLUMNS)[number];

export type PlannedCsvRow = {
  line: number;
  occurredOn: string;
  payee: string;
  amountCents: Cents;
  accountName: string;
  categoryName: string;
  fingerprint: string;
};

export type ResolvedCsvRow = PlannedCsvRow & {
  accountId: string;
  categoryId: string;
};

export type CsvLedger = {
  rows: readonly { fingerprint: string }[];
};

export type CsvImportOutcome<Row extends { fingerprint: string }> = {
  addedRows: readonly Row[];
  added: number;
  parsedRows: number;
};

type CsvRecord = {
  line: number;
  cells: string[];
};

/**
 * Import CSV rows into a household ledger. The same file imported again
 * contributes nothing: each row's fingerprint is the file contents plus its
 * position, so identical lines in one file stay distinct and a second pass
 * matches them all.
 */
export function importCsv(
  csv: string,
  ledger: CsvLedger,
): Promise<Result<CsvImportOutcome<PlannedCsvRow>, CsvImportError>>;
export function importCsv<Row extends { fingerprint: string }>(
  csv: string,
  ledger: CsvLedger,
  adapt: (rows: readonly PlannedCsvRow[]) => Result<readonly Row[], CsvImportError>,
): Promise<Result<CsvImportOutcome<Row>, CsvImportError>>;
export async function importCsv<Row extends { fingerprint: string }>(
  csv: string,
  ledger: CsvLedger,
  adapt?: (rows: readonly PlannedCsvRow[]) => Result<readonly Row[], CsvImportError>,
): Promise<Result<CsvImportOutcome<Row>, CsvImportError>> {
  const planned = await planCsvImport(csv);
  if (planned.isErr()) return err(planned.error);
  const adapted = adapt ? adapt(planned.value) : ok(planned.value as unknown as readonly Row[]);
  if (adapted.isErr()) return err(adapted.error);
  const merged = importCsvInto(ledger, adapted.value);
  return ok({
    addedRows: merged,
    added: merged.length,
    parsedRows: planned.value.length,
  });
}

export function resolveCsvRows(
  rows: readonly PlannedCsvRow[],
  accounts: readonly { id: string; name: string }[],
  categories: readonly { id: string; name: string }[],
  rules: readonly PayeeCategoryRule[] = [],
): Result<readonly ResolvedCsvRow[], CsvImportError> {
  const resolved: ResolvedCsvRow[] = [];
  for (const row of rows) {
    const accountId = matchName("account", row.line, row.accountName, accounts);
    if (accountId.isErr()) return err(accountId.error);
    const rule = matchingPayeeRule(row.payee, rules);
    if (rule) {
      const known = categories.some((category) => category.id === rule.categoryId);
      if (!known) {
        return err(
          new CsvImportError(
            `Row ${row.line}: That payee rule uses a category this household does not have.`,
          ),
        );
      }
      resolved.push({ ...row, accountId: accountId.value, categoryId: rule.categoryId });
      continue;
    }
    if (row.categoryName.length < 1) {
      return err(new CsvImportError(`Row ${row.line}: Enter a category.`));
    }
    const categoryId = matchName("category", row.line, row.categoryName, categories);
    if (categoryId.isErr()) return err(categoryId.error);
    resolved.push({ ...row, accountId: accountId.value, categoryId: categoryId.value });
  }
  return ok(resolved);
}

function importCsvInto<Row extends { fingerprint: string }>(
  ledger: CsvLedger,
  rows: readonly Row[],
): Row[] {
  const known = new Set(ledger.rows.map((row) => row.fingerprint));
  const added: Row[] = [];
  for (const row of rows) {
    if (known.has(row.fingerprint)) continue;
    known.add(row.fingerprint);
    added.push(row);
  }
  return added;
}

async function planCsvImport(csv: string): Promise<Result<PlannedCsvRow[], CsvImportError>> {
  if (csv.length > MAX_CSV_CHARS) {
    return err(new CsvImportError("That CSV is too large."));
  }
  const table = parseCsvTable(csv);
  if (table.isErr()) return err(table.error);
  if (table.value.length === 0) {
    return err(new CsvImportError("That CSV is empty."));
  }
  const header = table.value[0];
  const columns = headerIndex(header.cells);
  if (columns.isErr()) return err(columns.error);
  const data = table.value.slice(1);
  if (data.length === 0) {
    return err(new CsvImportError("That CSV has no transactions."));
  }
  if (data.length > MAX_ROWS) {
    return err(new CsvImportError(`A CSV import can include at most ${MAX_ROWS} transactions.`));
  }

  const draft: Array<Omit<PlannedCsvRow, "fingerprint">> = [];
  for (const record of data) {
    if (record.cells.length !== header.cells.length) {
      return err(
        new CsvImportError(`Row ${record.line} does not match the header column count.`),
      );
    }
    const parsed = parseDataRow(record, columns.value);
    if (parsed.isErr()) return err(parsed.error);
    draft.push(parsed.value);
  }

  const canonical = JSON.stringify(
    draft.map((row) => [row.occurredOn, row.payee, row.amountCents, row.accountName, row.categoryName]),
  );
  const contentSha256 = await sha256Hex(canonical);
  return ok(
    draft.map((row, index) => ({
      ...row,
      fingerprint: `${contentSha256}:${index}`,
    })),
  );
}

function parseDataRow(
  record: CsvRecord,
  columns: Record<ColumnName, number>,
): Result<Omit<PlannedCsvRow, "fingerprint">, CsvImportError> {
  const cell = (name: ColumnName) => record.cells[columns[name]] ?? "";
  const occurredOn = parseIsoDate(cell("date"));
  if (!occurredOn) {
    return err(new CsvImportError(`Row ${record.line}: Use a date like 2026-03-02.`));
  }
  const payee = cell("payee");
  if (payee.length < 1) {
    return err(new CsvImportError(`Row ${record.line}: Enter a payee.`));
  }
  if (payee.length > MAX_PAYEE || /[\r\n]/.test(payee)) {
    return err(new CsvImportError(`Row ${record.line}: That payee is not usable.`));
  }
  const amount = parseDollarInput(cell("amount"));
  if (amount.isErr()) {
    return err(new CsvImportError(`Row ${record.line}: ${amount.error.message}`));
  }
  if (amount.value === 0) {
    return err(new CsvImportError(`Row ${record.line}: Enter an amount other than zero.`));
  }
  const accountName = cell("account");
  const categoryName = cell("category");
  if (accountName.length < 1) {
    return err(new CsvImportError(`Row ${record.line}: Enter an account.`));
  }
  return ok({
    line: record.line,
    occurredOn,
    payee,
    amountCents: amount.value,
    accountName,
    categoryName,
  });
}

function headerIndex(cells: string[]): Result<Record<ColumnName, number>, CsvImportError> {
  if (cells.length > MAX_COLUMNS) {
    return err(new CsvImportError("That CSV has too many columns."));
  }
  const index = new Map<string, number>();
  for (let i = 0; i < cells.length; i += 1) {
    const name = cells[i].trim().toLowerCase();
    if (name.length === 0) continue;
    if (index.has(name)) {
      return err(new CsvImportError(`The column "${cells[i]}" is repeated.`));
    }
    index.set(name, i);
  }
  const columns = {} as Record<ColumnName, number>;
  for (const name of COLUMNS) {
    const found = index.get(name);
    if (found == null) {
      return err(
        new CsvImportError("The CSV needs date, payee, amount, account, and category columns."),
      );
    }
    columns[name] = found;
  }
  return ok(columns);
}

function parseCsvTable(raw: string): Result<CsvRecord[], CsvImportError> {
  const source = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let fieldStart = 1;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 1;
          continue;
        }
        inQuotes = false;
        continue;
      }
      if (char === "\n") line += 1;
      field += char;
      continue;
    }
    if (char === '"') {
      if (field.length > 0) {
        return err(new CsvImportError(`Row ${line}: Quotes have to wrap a whole field.`));
      }
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      cells.push(field.trim());
      field = "";
      continue;
    }
    if (char === "\n") {
      cells.push(field.trim());
      if (cells.some((cell) => cell.length > 0)) {
        records.push({ line: fieldStart, cells });
      }
      cells = [];
      field = "";
      line += 1;
      fieldStart = line;
      continue;
    }
    field += char;
  }
  if (inQuotes) return err(new CsvImportError("A quoted field was left open."));
  if (field.length > 0 || cells.length > 0) {
    cells.push(field.trim());
    if (cells.some((cell) => cell.length > 0)) {
      records.push({ line: fieldStart, cells });
    }
  }
  return ok(records);
}

function parseIsoDate(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 2200) return null;
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    return null;
  }
  return value;
}

function matchName(
  label: string,
  line: number,
  name: string,
  options: readonly { id: string; name: string }[],
): Result<string, CsvImportError> {
  const wanted = name.trim().toLowerCase();
  const matches = options.filter((option) => option.name.trim().toLowerCase() === wanted);
  if (matches.length === 1) return ok(matches[0].id);
  if (matches.length === 0) {
    return err(new CsvImportError(`Row ${line}: No ${label} named "${name}".`));
  }
  return err(new CsvImportError(`Row ${line}: More than one ${label} is named "${name}".`));
}

type SubtleDigest = {
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
};

async function sha256Hex(value: string): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleDigest } }).crypto?.subtle;
  if (!subtle) {
    throw new CsvImportError("Could not fingerprint that CSV.");
  }
  const digest = await subtle.digest("SHA-256", utf8Bytes(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function utf8Bytes(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i += 1) {
    let code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}
