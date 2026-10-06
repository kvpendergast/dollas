import { err, ok, type Result } from "neverthrow";
import { CsvImportError } from "../errors";
import { parseDollarInput, type Cents } from "../money/cents";
import { CSV_IMPORT_MAX_CHARS, csvTooLargeMessage } from "./csv";
import { sha256Hex } from "./fingerprint";
import { parseCsvTable, type CsvRecord } from "./parse";

/** Columns kept from one file. Extra columns past this are refused. */
export const CSV_MAX_COLUMNS = 64;
const SAMPLE_ROWS = 5;
const MAX_DATA_ROWS = 5_000;

export type DateOrder = "ymd" | "mdy" | "dmy";
export type AmountMode = "signed" | "debit_credit";
export type AccountMode = "column" | "fixed";

/**
 * Which source column fills each Dollas field.
 * Amount is either one signed column or a debit column and a credit column.
 * Account is either a column or one Dollas account for the whole file.
 * Category and notes are optional.
 */
export type ColumnMapping = {
  hasHeader: boolean;
  dateColumn: number | null;
  payeeColumn: number | null;
  amountMode: AmountMode;
  amountColumn: number | null;
  debitColumn: number | null;
  creditColumn: number | null;
  flipSign: boolean;
  dateOrder: DateOrder | null;
  accountMode: AccountMode;
  accountColumn: number | null;
  fixedAccountId: string | null;
  categoryColumn: number | null;
  notesColumn: number | null;
};

export type CsvColumn = {
  index: number;
  label: string;
};

export type SavedCsvMapping = {
  id: string;
  householdId: string;
  headerSignature: string;
  accountId: string | null;
  mapping: ColumnMapping;
  updatedAt: string;
};

export type CsvTableLayout = {
  width: number;
  headers: { index: number; norm: string }[];
  columns: CsvColumn[];
  headerRow: string[] | null;
  data: CsvRecord[];
  headerSignature: string;
  hasHeader: boolean;
};

export type CsvInspection = {
  headerSignature: string;
  hasHeader: boolean;
  columns: CsvColumn[];
  headerRow: string[] | null;
  sampleRows: string[][];
  mapping: ColumnMapping;
  dateOrderAmbiguous: boolean;
  reusedSavedMapping: boolean;
  /** Mappings remembered for a Dollas account, so a no-header file can reuse one. */
  savedForAccounts: { accountId: string; mapping: ColumnMapping }[];
};

const DATE_HEADERS = [
  "transaction date",
  "posted date",
  "posting date",
  "post date",
  "trans date",
  "txn date",
  "value date",
  "booking date",
  "processed date",
  "process date",
  "trade date",
  "date",
  "posted",
] as const;

const PAYEE_HEADERS = [
  "merchant",
  "merchant name",
  "payee",
  "payee name",
  "transaction description",
  "description",
  "narrative",
  "details",
  "name",
] as const;

const AMOUNT_HEADERS = ["amount", "transaction amount", "amt", "amount usd", "sum"] as const;
const DEBIT_HEADERS = ["debit", "debit amount", "withdrawal", "withdrawals", "money out", "outflow"] as const;
const CREDIT_HEADERS = ["credit", "credit amount", "deposit", "deposits", "money in", "inflow"] as const;
const ACCOUNT_HEADERS = ["account name", "account"] as const;
const CATEGORY_HEADERS = ["category", "category name", "categories", "subcategory"] as const;
const NOTES_HEADERS = ["notes", "note", "memo", "comment", "comments", "reference"] as const;

const KNOWN_HEADERS = new Set<string>([
  ...DATE_HEADERS,
  ...PAYEE_HEADERS,
  ...AMOUNT_HEADERS,
  ...DEBIT_HEADERS,
  ...CREDIT_HEADERS,
  ...ACCOUNT_HEADERS,
  ...CATEGORY_HEADERS,
  ...NOTES_HEADERS,
]);

export function emptyMapping(hasHeader: boolean): ColumnMapping {
  return {
    hasHeader,
    dateColumn: null,
    payeeColumn: null,
    amountMode: "signed",
    amountColumn: null,
    debitColumn: null,
    creditColumn: null,
    flipSign: false,
    dateOrder: null,
    accountMode: "fixed",
    accountColumn: null,
    fixedAccountId: null,
    categoryColumn: null,
    notesColumn: null,
  };
}

/** Lowercase header text with punctuation folded to spaces, for synonym matching. */
export function normHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_./]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Propose a column mapping from the file.
 * A saved mapping for this header signature is used as-is so the next import
 * from the same bank can skip the mapper. Pass `hasHeader` when the member
 * overrides the auto-detection.
 */
export async function inspectCsvImport(
  csv: string,
  options: {
    savedMappings?: readonly SavedCsvMapping[];
    hasHeader?: boolean;
  } = {},
): Promise<Result<CsvInspection, CsvImportError>> {
  const opened = await openCsvTable(csv, options.hasHeader);
  if (opened.isErr()) return err(opened.error);
  const laid = opened.value;
  const guessed = guessMapping(laid.headers, laid.data, laid.hasHeader);
  const saved = savedForShape(options.savedMappings ?? [], laid.headerSignature, laid.width, laid.hasHeader);
  const mapping = saved ? { ...saved.mapping, hasHeader: laid.hasHeader } : guessed.mapping;
  const orderKnown = Boolean(saved?.mapping.dateOrder);
  if (orderKnown) mapping.dateOrder = saved?.mapping.dateOrder ?? mapping.dateOrder;
  const ambiguous = orderKnown ? false : guessed.dateOrderAmbiguous;
  const savedForAccounts = (options.savedMappings ?? [])
    .filter((row) => row.accountId && mappingFits(row.mapping, laid.width, laid.hasHeader))
    .map((row) => ({ accountId: row.accountId as string, mapping: { ...row.mapping, hasHeader: laid.hasHeader } }));
  return ok({
    headerSignature: laid.headerSignature,
    hasHeader: laid.hasHeader,
    columns: laid.columns,
    headerRow: laid.headerRow,
    sampleRows: laid.data.slice(0, SAMPLE_ROWS).map((row) => pad(row.cells, laid.width)),
    mapping,
    dateOrderAmbiguous: ambiguous && !mapping.dateOrder,
    reusedSavedMapping: Boolean(saved && mappingReady(mapping, ambiguous && !mapping.dateOrder)),
    savedForAccounts,
  });
}

/**
 * Saved mapping for this file shape, or the newest mapping remembered for one account.
 * Header signature wins when both match.
 */
/**
 * Signature stored for a mapping. Header files use the header hash.
 * A no-header file that uses one Dollas account is remembered for that account,
 * so two banks with the same column count do not overwrite each other.
 */
export function mappingSignature(headerSignature: string, mapping: ColumnMapping): string {
  if (!mapping.hasHeader && mapping.accountMode === "fixed" && mapping.fixedAccountId) {
    return `${headerSignature}:account:${mapping.fixedAccountId}`;
  }
  return headerSignature;
}

function savedForShape(
  saved: readonly SavedCsvMapping[],
  headerSignature: string,
  width: number,
  hasHeader: boolean,
): SavedCsvMapping | null {
  const exact = saved.find((row) => row.headerSignature === headerSignature);
  if (exact && mappingFits(exact.mapping, width, hasHeader)) return exact;
  if (hasHeader) return null;
  const scoped = saved.filter(
    (row) => row.headerSignature.startsWith(`${headerSignature}:account:`) && mappingFits(row.mapping, width, hasHeader),
  );
  return scoped.length === 1 ? scoped[0] : null;
}

export function lookupSavedMapping(
  saved: readonly SavedCsvMapping[],
  headerSignature: string,
  accountId: string | null,
): SavedCsvMapping | null {
  const bySignature = saved.find((row) => row.headerSignature === headerSignature);
  if (bySignature) return bySignature;
  if (!accountId) return null;
  const byAccount = saved
    .filter((row) => row.accountId === accountId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return byAccount[0] ?? null;
}

export function mappingReady(mapping: ColumnMapping, dateOrderAmbiguous: boolean): boolean {
  if (mapping.dateColumn == null || mapping.payeeColumn == null) return false;
  if (mapping.amountMode === "signed" && mapping.amountColumn == null) return false;
  if (mapping.amountMode === "debit_credit" && (mapping.debitColumn == null || mapping.creditColumn == null)) {
    return false;
  }
  if (mapping.accountMode === "column" && mapping.accountColumn == null) return false;
  if (mapping.accountMode === "fixed" && !mapping.fixedAccountId) return false;
  if (dateOrderAmbiguous && !mapping.dateOrder) return false;
  return true;
}

export type ParsedCsvAmount =
  | { ok: true; cents: Cents }
  | { ok: false; reason: "empty" | "not_number" | "zero" | "precision" | "large" };

/**
 * Dollars and cents from a bank cell. Currency symbols, thousands separators,
 * and parentheses (accounting negatives) are accepted. More than two decimal
 * places is rejected so cents stay exact.
 */
export function parseCsvAmount(raw: string): ParsedCsvAmount {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed === "-" || trimmed === "--") return { ok: false, reason: "empty" };
  let body = trimmed;
  let negative = false;
  const wrapped = /^\((.*)\)$/.exec(body.replace(/\s+/g, " ").trim());
  if (wrapped) {
    negative = true;
    body = wrapped[1] ?? "";
  }
  body = body.replace(/us\$/gi, "").replace(/[$€£¥]/g, "").replace(/\b(?:usd|eur|gbp|cad|aud)\b/gi, "");
  const cleaned = body.trim().replace(/[$,\s]/g, "");
  if (/^[+-]?\d+\.\d{3,}$/.test(cleaned)) return { ok: false, reason: "precision" };
  const parsed = parseDollarInput(negative ? `-${cleaned}` : cleaned);
  if (parsed.isErr()) {
    if (parsed.error.message.includes("too large")) return { ok: false, reason: "large" };
    return { ok: false, reason: "not_number" };
  }
  const cents = parsed.value;
  if (cents === 0) return { ok: false, reason: "zero" };
  return { ok: true, cents };
}

export type DateRead =
  | { ok: true; iso: string; order: DateOrder }
  | { ok: false; reason: "empty" | "invalid" | "ambiguous" };

/** Read one date cell. `order` is required when the numbers could be month-first or day-first. */
export function readCsvDate(raw: string, order: DateOrder | null): DateRead {
  const value = raw.trim();
  if (value.length === 0) return { ok: false, reason: "empty" };
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value);
  if (iso) {
    const normalized = calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    return normalized ? { ok: true, iso: normalized, order: "ymd" } : { ok: false, reason: "invalid" };
  }
  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(value);
  if (!numeric) return { ok: false, reason: "invalid" };
  const first = Number(numeric[1]);
  const second = Number(numeric[2]);
  const year = expandYear(Number(numeric[3]));
  if (order === "mdy" || order === "dmy") {
    if ((order === "mdy" && first > 12) || (order === "dmy" && second > 12)) {
      return { ok: false, reason: "invalid" };
    }
    const month = order === "mdy" ? first : second;
    const day = order === "mdy" ? second : first;
    const normalized = calendarDate(year, month, day);
    return normalized ? { ok: true, iso: normalized, order } : { ok: false, reason: "invalid" };
  }
  if (first > 12 && second <= 12) {
    const normalized = calendarDate(year, second, first);
    return normalized ? { ok: true, iso: normalized, order: "dmy" } : { ok: false, reason: "invalid" };
  }
  if (second > 12 && first <= 12) {
    const normalized = calendarDate(year, first, second);
    return normalized ? { ok: true, iso: normalized, order: "mdy" } : { ok: false, reason: "invalid" };
  }
  if (first <= 12 && second <= 12 && order == null) return { ok: false, reason: "ambiguous" };
  return { ok: false, reason: "invalid" };
}

/**
 * Decide MDY vs DMY from a column. ISO dates do not need a choice.
 * Mixed evidence (one row must be month-first, another day-first) is inconsistent.
 */
export function detectDateOrder(values: readonly string[]): {
  order: DateOrder | null;
  ambiguous: boolean;
  inconsistent: boolean;
} {
  let mdy = false;
  let dmy = false;
  let ymd = false;
  let ambiguous = false;
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(trimmed)) {
      ymd = true;
      continue;
    }
    const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(trimmed);
    if (!numeric) continue;
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    if (first > 12 && second > 12) continue;
    if (first > 12 && second <= 12) dmy = true;
    else if (second > 12 && first <= 12) mdy = true;
    else ambiguous = true;
  }
  if (mdy && dmy) return { order: null, ambiguous: false, inconsistent: true };
  if (mdy) return { order: "mdy", ambiguous: false, inconsistent: false };
  if (dmy) return { order: "dmy", ambiguous: false, inconsistent: false };
  if (ambiguous) return { order: null, ambiguous: true, inconsistent: false };
  if (ymd) return { order: "ymd", ambiguous: false, inconsistent: false };
  return { order: null, ambiguous: false, inconsistent: false };
}

/** Parse the file and split the header from the data rows. */
export async function openCsvTable(
  csv: string,
  hasHeader?: boolean,
): Promise<Result<CsvTableLayout, CsvImportError>> {
  if (csv.length > CSV_IMPORT_MAX_CHARS) return err(new CsvImportError(csvTooLargeMessage()));
  const table = parseCsvTable(csv);
  if (table.isErr()) return err(table.error);
  if (table.value.length === 0) return err(new CsvImportError("That CSV is empty."));
  const headerChosen = hasHeader ?? rowLooksLikeHeader(table.value[0].cells);
  const header = headerChosen ? table.value[0] : null;
  const data = headerChosen ? table.value.slice(1) : table.value;
  if (data.length === 0) return err(new CsvImportError("That CSV has no transactions."));
  if (data.length > MAX_DATA_ROWS) {
    return err(new CsvImportError(`A CSV import can include at most ${MAX_DATA_ROWS} transactions.`));
  }
  const width = headerChosen
    ? (header?.cells.length ?? 0)
    : data.reduce((max, row) => Math.max(max, row.cells.length), 0);
  if (width < 1) return err(new CsvImportError("That CSV has no columns."));
  if (width > CSV_MAX_COLUMNS) return err(new CsvImportError("That CSV has too many columns."));
  const headerCells = header ? pad(header.cells, width) : null;
  const signatureSource = headerChosen
    ? `header:${(headerCells ?? []).map((cell) => normHeader(cell)).join("\u001f")}`
    : `no-header:${width}`;
  const headerSignature = headerChosen ? await sha256Hex(signatureSource) : signatureSource;
  return ok({
    width,
    headers: (headerCells ?? []).map((cell, index) => ({ index, norm: normHeader(cell) })),
    columns: columnLabels(headerCells, width),
    headerRow: headerCells,
    data,
    headerSignature,
    hasHeader: headerChosen,
  });
}

function guessMapping(
  headers: { index: number; norm: string }[],
  data: CsvRecord[],
  hasHeader: boolean,
): { mapping: ColumnMapping; dateOrderAmbiguous: boolean } {
  const mapping = emptyMapping(hasHeader);
  if (!hasHeader) return { mapping, dateOrderAmbiguous: false };
  const used = new Set<number>();
  const take = (names: readonly string[]) => {
    for (const name of names) {
      const found = headers.find((header) => header.norm === name && !used.has(header.index));
      if (found) {
        used.add(found.index);
        return found.index;
      }
    }
    return null;
  };
  mapping.dateColumn = take(DATE_HEADERS);
  mapping.payeeColumn = take(PAYEE_HEADERS);
  const debitColumn = take(DEBIT_HEADERS);
  const creditColumn = take(CREDIT_HEADERS);
  const amountColumn = take(AMOUNT_HEADERS);
  if (debitColumn != null && creditColumn != null) {
    mapping.amountMode = "debit_credit";
    mapping.debitColumn = debitColumn;
    mapping.creditColumn = creditColumn;
    mapping.amountColumn = null;
  } else {
    mapping.amountMode = "signed";
    mapping.amountColumn = amountColumn ?? debitColumn ?? creditColumn;
    mapping.debitColumn = null;
    mapping.creditColumn = null;
  }
  mapping.accountColumn = take(ACCOUNT_HEADERS);
  mapping.accountMode = mapping.accountColumn == null ? "fixed" : "column";
  mapping.categoryColumn = take(CATEGORY_HEADERS);
  mapping.notesColumn = take(NOTES_HEADERS);
  const dateValues = mapping.dateColumn == null ? [] : data.map((row) => row.cells[mapping.dateColumn as number] ?? "");
  const detected = detectDateOrder(dateValues);
  mapping.dateOrder = detected.inconsistent ? null : detected.order;
  return { mapping, dateOrderAmbiguous: detected.ambiguous || detected.inconsistent };
}

function mappingFits(mapping: ColumnMapping, width: number, hasHeader: boolean): boolean {
  if (mapping.hasHeader !== hasHeader) return false;
  const indexes = [
    mapping.dateColumn,
    mapping.payeeColumn,
    mapping.amountColumn,
    mapping.debitColumn,
    mapping.creditColumn,
    mapping.accountColumn,
    mapping.categoryColumn,
    mapping.notesColumn,
  ];
  return indexes.every((index) => index == null || (index >= 0 && index < width));
}

function rowLooksLikeHeader(cells: string[]): boolean {
  const norms = cells.map(normHeader).filter((cell) => cell.length > 0);
  if (norms.some((cell) => KNOWN_HEADERS.has(cell))) return true;
  if (cells.some((cell) => looksLikeDate(cell) || looksLikeAmount(cell))) return false;
  return norms.length > 0;
}

function looksLikeDate(value: string): boolean {
  return /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(value.trim());
}

function looksLikeAmount(value: string): boolean {
  return /^[($€£¥+-]*\d[\d,.\s]*\)?$/.test(value.trim());
}

function columnLabels(header: string[] | null, width: number): CsvColumn[] {
  const seen = new Map<string, number>();
  const labels: CsvColumn[] = [];
  for (let index = 0; index < width; index += 1) {
    const raw = header?.[index]?.trim() || `Column ${index + 1}`;
    const key = raw.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    labels.push({ index, label: count === 1 ? raw : `${raw} (${count})` });
  }
  return labels;
}

function pad(cells: string[], width: number): string[] {
  const next = cells.slice(0, width);
  while (next.length < width) next.push("");
  return next;
}

function expandYear(year: number): number {
  if (year >= 100) return year;
  return year >= 70 ? 1900 + year : 2000 + year;
}

function calendarDate(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
