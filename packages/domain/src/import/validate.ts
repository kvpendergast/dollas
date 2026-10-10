import { err, ok, type Result } from "neverthrow";
import { CsvImportError } from "../errors";
import type { Cents } from "../money/cents";
import { matchingPayeeRule, type PayeeCategoryRule } from "../rules/payee-category";
import { pairCharges } from "../connections/match";
import { fingerprintNormalizedRows } from "./fingerprint";
import {
  detectDateOrder,
  openCsvTable,
  parseCsvAmount,
  readCsvDate,
  type ColumnMapping,
  type DateOrder,
} from "./mapping";

/**
 * One schema for preview and commit. A row is ready only when every required
 * field parses. Category and notes may be blank. Unknown accounts and
 * categories are cell errors, not a reason to reject the rest of the file.
 */
export const mappedTransactionSchema = {
  date: { required: true, label: "Date" },
  payee: { required: true, label: "Payee", maxLength: 200 },
  amount: { required: true, label: "Amount" },
  account: { required: true, label: "Account" },
  category: { required: false, label: "Category" },
  notes: { required: false, label: "Notes", maxLength: 500 },
} as const;

export type MappedField = keyof typeof mappedTransactionSchema;

export type CellError = {
  line: number;
  field: MappedField;
  value: string;
  message: string;
};

export type ImportAccount = { id: string; name: string };
export type ImportCategory = { id: string; name: string; kind: string };

export type MappedImportContext = {
  accounts: readonly ImportAccount[];
  categories: readonly ImportCategory[];
  rules: readonly PayeeCategoryRule[];
  fingerprints: readonly { fingerprint: string }[];
  /**
   * Rows the bank already backs (PEN-203), deleted ones included. A ready CSV
   * row that pairs with one (same account and cents, dates within the match
   * window, one to one) is a duplicate and is not added.
   */
  bankCharges?: readonly BankBackedCharge[];
};

export type BankBackedCharge = {
  id: string;
  accountId: string;
  occurredOn: string;
  /** The bank's own date when it differs from the book date (a linked row). */
  bankOccurredOn: string | null;
  amountCents: Cents;
  payee: string;
  deleted: boolean;
  createdAt: string;
};

export type CategoryChoice =
  | { kind: "id"; id: string }
  | { kind: "fallback"; fallback: "income" | "expense" };

export type CommitCsvRow = {
  line: number;
  occurredOn: string;
  payee: string;
  amountCents: Cents;
  accountId: string;
  accountName: string;
  categoryName: string;
  category: CategoryChoice;
  note: string | null;
  fingerprint: string;
};

export type MappedCell = {
  field: MappedField;
  text: string;
  message: string | null;
};

export type MappedPreviewRow = {
  line: number;
  status: "ready" | "error" | "duplicate";
  /** Why a duplicate row is skipped: this file (or its rows) was imported before, or the bank already synced the charge. */
  duplicateOf?: "import" | "bank";
  cells: MappedCell[];
  amountCents: Cents | null;
  fingerprint: string | null;
  commit: CommitCsvRow | null;
};

export type MappedValidation = {
  headerSignature: string;
  rows: MappedPreviewRow[];
  ready: CommitCsvRow[];
  readyCount: number;
  errorCount: number;
  duplicateCount: number;
};

const FIELD_ORDER: MappedField[] = ["date", "payee", "amount", "account", "category", "notes"];

/**
 * Validate every data row against the mapping. Nothing is written.
 * Ready rows are the ones a commit may insert. Duplicate rows are already
 * in the books, including soft-deleted fingerprints. Error rows are skipped
 * by commit.
 */
export async function validateMappedImport(
  csv: string,
  mapping: ColumnMapping,
  context: MappedImportContext,
): Promise<Result<MappedValidation, CsvImportError>> {
  const table = await openCsvTable(csv, mapping.hasHeader);
  if (table.isErr()) return err(table.error);
  const laid = table.value;
  const shape = assertMapping(mapping, laid.width, laid.data.map((row) => cellAt(row.cells, mapping.dateColumn, laid.width)));
  if (shape.isErr()) return err(shape.error);
  if (mapping.accountMode === "fixed" && !context.accounts.some((account) => account.id === mapping.fixedAccountId)) {
    return err(new CsvImportError("Choose an account for this file."));
  }

  const draft: Array<{
    line: number;
    errors: CellError[];
    texts: Record<MappedField, string>;
    amountCents: Cents | null;
    normalized: {
      occurredOn: string;
      payee: string;
      amountCents: Cents;
      accountName: string;
      categoryName: string;
    } | null;
    commit: Omit<CommitCsvRow, "fingerprint"> | null;
  }> = [];

  for (const record of laid.data) {
    const cells = pad(record.cells, laid.width);
    draft.push(validateRow(record.line, cells, mapping, shape.value, context));
  }

  const normalized = draft.flatMap((row) => (row.normalized ? [row.normalized] : []));
  const fingerprints = await fingerprintNormalizedRows(normalized);
  let fingerprintCursor = 0;
  const known = new Set(context.fingerprints.map((row) => row.fingerprint));
  const rows: MappedPreviewRow[] = [];
  let ready: CommitCsvRow[] = [];

  for (const row of draft) {
    if (row.errors.length > 0 || !row.commit || !row.normalized) {
      rows.push({
        line: row.line,
        status: "error",
        cells: presentCells(row.texts, row.errors),
        amountCents: null,
        fingerprint: null,
        commit: null,
      });
      continue;
    }
    const fingerprint = fingerprints[fingerprintCursor] ?? "";
    fingerprintCursor += 1;
    if (known.has(fingerprint)) {
      rows.push({
        line: row.line,
        status: "duplicate",
        duplicateOf: "import",
        cells: presentCells(row.texts, []),
        amountCents: row.amountCents,
        fingerprint,
        commit: null,
      });
      continue;
    }
    known.add(fingerprint);
    const commit = { ...row.commit, fingerprint };
    ready.push(commit);
    rows.push({
      line: row.line,
      status: "ready",
      cells: presentCells(row.texts, []),
      amountCents: row.amountCents,
      fingerprint,
      commit,
    });
  }

  const synced = alreadySynced(ready, context.bankCharges ?? []);
  if (synced.size > 0) {
    for (const row of rows) {
      if (row.status !== "ready" || !row.fingerprint || !synced.has(row.fingerprint)) continue;
      row.status = "duplicate";
      row.duplicateOf = "bank";
      row.commit = null;
    }
    ready = ready.filter((row) => !synced.has(row.fingerprint));
  }

  return ok({
    headerSignature: laid.headerSignature,
    rows,
    ready,
    readyCount: ready.length,
    errorCount: rows.filter((row) => row.status === "error").length,
    duplicateCount: rows.filter((row) => row.status === "duplicate").length,
  });
}

function validateRow(
  line: number,
  cells: string[],
  mapping: ColumnMapping,
  order: DateOrder,
  context: MappedImportContext,
): {
  line: number;
  errors: CellError[];
  texts: Record<MappedField, string>;
  amountCents: Cents | null;
  normalized: {
    occurredOn: string;
    payee: string;
    amountCents: Cents;
    accountName: string;
    categoryName: string;
  } | null;
  commit: Omit<CommitCsvRow, "fingerprint"> | null;
} {
  const errors: CellError[] = [];
  const dateRaw = cellAt(cells, mapping.dateColumn, cells.length);
  const payeeRaw = cellAt(cells, mapping.payeeColumn, cells.length);
  const categoryRaw = mapping.categoryColumn == null ? "" : cellAt(cells, mapping.categoryColumn, cells.length);
  const notesRaw = mapping.notesColumn == null ? "" : cellAt(cells, mapping.notesColumn, cells.length);
  const amountRaw = amountRawText(cells, mapping);

  const date = readCsvDate(dateRaw, order);
  let occurredOn = "";
  if (!date.ok) {
    errors.push(cellIssue(line, "date", dateRaw, "isn't a date"));
  } else {
    occurredOn = date.iso;
  }

  let payee = payeeRaw.trim();
  if (payee.length < 1) errors.push(plainIssue(line, "payee", payeeRaw, "Enter a payee."));
  else if (payee.length > mappedTransactionSchema.payee.maxLength || /[\r\n]/.test(payee)) {
    errors.push(plainIssue(line, "payee", payeeRaw, "That payee is not usable."));
  }

  const amount = readAmount(line, cells, mapping);
  if (!amount.ok) errors.push(amount.error);
  const amountCents = amount.ok ? amount.cents : 0;

  const account = readAccount(line, cells, mapping, context.accounts);
  if (!account.ok) errors.push(account.error);

  let note: string | null = notesRaw.trim();
  if (note.length === 0) note = null;
  else if (note.length > mappedTransactionSchema.notes.maxLength) {
    errors.push(plainIssue(line, "notes", notesRaw, "That note is too long."));
    note = null;
  }

  const categoryName = categoryRaw.trim();
  let category: CategoryChoice | null = null;
  let categoryText = categoryName;
  const rule = payee.length > 0 ? matchingPayeeRule(payee, context.rules) : null;
  if (rule) {
    const known = context.categories.find((item) => item.id === rule.categoryId);
    if (!known) {
      errors.push(plainIssue(line, "category", categoryName, "That payee rule uses a category this household does not have."));
    } else {
      category = { kind: "id", id: known.id };
      categoryText = known.name;
    }
  } else if (categoryName.length === 0) {
    if (amount.ok) {
      const fallback = amountCents > 0 ? "income" : "expense";
      category = fallbackChoice(fallback, context.categories);
      categoryText = fallback === "income" ? "Uncategorized income" : "Uncategorized";
    }
  } else {
    const matched = matchByName(categoryName, context.categories);
    if (matched.kind === "one") {
      category = { kind: "id", id: matched.id };
      categoryText = matched.name;
    } else if (matched.kind === "none") {
      errors.push(plainIssue(line, "category", categoryName, `No category named "${categoryName}".`));
    } else {
      errors.push(plainIssue(line, "category", categoryName, `More than one category is named "${categoryName}".`));
    }
  }

  const texts: Record<MappedField, string> = {
    date: date.ok ? date.iso : dateRaw,
    payee,
    amount: amountRaw,
    account: account.ok ? account.name : accountRaw(cells, mapping),
    category: categoryText,
    notes: notesRaw.trim(),
  };

  if (errors.length > 0 || !date.ok || !amount.ok || !account.ok || !category) {
    return { line, errors, texts, amountCents: amount.ok ? amount.cents : null, normalized: null, commit: null };
  }

  return {
    line,
    errors,
    amountCents,
    texts: { ...texts, amount: "" },
    normalized: {
      occurredOn,
      payee,
      amountCents,
      accountName: account.fingerprintName,
      categoryName,
    },
    commit: {
      line,
      occurredOn,
      payee,
      amountCents,
      accountId: account.id,
      accountName: account.name,
      categoryName: categoryText,
      category,
      note,
    },
  };
}

function assertMapping(
  mapping: ColumnMapping,
  width: number,
  dateValues: string[],
): Result<DateOrder, CsvImportError> {
  const claims = new Map<number, string>();
  const claim = (index: number | null, label: string): Result<void, CsvImportError> => {
    if (index == null) return ok(undefined);
    if (index < 0 || index >= width) return err(new CsvImportError(`Choose a ${label} column from this file.`));
    const previous = claims.get(index);
    if (previous) return err(new CsvImportError(`That column is already used for ${previous}.`));
    claims.set(index, label);
    return ok(undefined);
  };
  if (mapping.dateColumn == null) return err(new CsvImportError("Choose a date column."));
  if (mapping.payeeColumn == null) return err(new CsvImportError("Choose a payee column."));
  const claimed = [
    claim(mapping.dateColumn, "the date"),
    claim(mapping.payeeColumn, "the payee"),
  ];
  if (mapping.amountMode === "debit_credit") {
    if (mapping.debitColumn == null || mapping.creditColumn == null) {
      return err(new CsvImportError("Choose a debit column and a credit column."));
    }
    claimed.push(claim(mapping.debitColumn, "the debit"), claim(mapping.creditColumn, "the credit"));
  } else if (mapping.amountColumn == null) {
    return err(new CsvImportError("Choose an amount column."));
  } else {
    claimed.push(claim(mapping.amountColumn, "the amount"));
  }
  if (mapping.accountMode === "column") {
    if (mapping.accountColumn == null) return err(new CsvImportError("Choose an account column."));
    claimed.push(claim(mapping.accountColumn, "the account"));
  } else if (!mapping.fixedAccountId) {
    return err(new CsvImportError("Choose an account for this file."));
  }
  claimed.push(claim(mapping.categoryColumn, "the category"), claim(mapping.notesColumn, "the notes"));
  const failed = claimed.find((item) => item.isErr());
  if (failed && failed.isErr()) return err(failed.error);

  const detected = detectDateOrder(dateValues);
  if ((detected.ambiguous || detected.inconsistent) && mapping.dateOrder !== "mdy" && mapping.dateOrder !== "dmy") {
    return err(new CsvImportError("Choose whether dates start with the month or the day."));
  }
  const order: DateOrder = mapping.dateOrder === "mdy" || mapping.dateOrder === "dmy" ? mapping.dateOrder : "ymd";
  return ok(order);
}

function readAmount(
  line: number,
  cells: string[],
  mapping: ColumnMapping,
): { ok: true; cents: Cents } | { ok: false; error: CellError } {
  if (mapping.amountMode === "debit_credit") {
    const debitRaw = cellAt(cells, mapping.debitColumn, cells.length);
    const creditRaw = cellAt(cells, mapping.creditColumn, cells.length);
    const debit = sideAmount(debitRaw);
    const credit = sideAmount(creditRaw);
    if (!debit.ok) return { ok: false, error: amountIssue(line, debitRaw, debit.reason) };
    if (!credit.ok) return { ok: false, error: amountIssue(line, creditRaw, credit.reason) };
    if (debit.cents != null && credit.cents != null) {
      return { ok: false, error: plainIssue(line, "amount", `${debitRaw} / ${creditRaw}`, "Use a debit or a credit, not both.") };
    }
    if (debit.cents == null && credit.cents == null) {
      const shown = debitRaw || creditRaw;
      return { ok: false, error: amountIssue(line, shown, shown.trim().length === 0 ? "empty" : "zero") };
    }
    const signed = (credit.cents ?? 0) - (debit.cents ?? 0);
    return { ok: true, cents: mapping.flipSign ? -signed : signed };
  }
  const raw = cellAt(cells, mapping.amountColumn, cells.length);
  const parsed = parseCsvAmount(raw);
  if (!parsed.ok) return { ok: false, error: amountIssue(line, raw, parsed.reason) };
  return { ok: true, cents: mapping.flipSign ? -parsed.cents : parsed.cents };
}

function sideAmount(raw: string): { ok: true; cents: Cents | null } | { ok: false; reason: "not_number" | "precision" | "large" } {
  const parsed = parseCsvAmount(raw);
  if (!parsed.ok) {
    if (parsed.reason === "empty" || parsed.reason === "zero") return { ok: true, cents: null };
    return { ok: false, reason: parsed.reason };
  }
  return { ok: true, cents: Math.abs(parsed.cents) };
}

function readAccount(
  line: number,
  cells: string[],
  mapping: ColumnMapping,
  accounts: readonly ImportAccount[],
):
  | { ok: true; id: string; name: string; fingerprintName: string }
  | { ok: false; error: CellError } {
  if (mapping.accountMode === "fixed") {
    const account = accounts.find((item) => item.id === mapping.fixedAccountId);
    if (!account) return { ok: false, error: plainIssue(line, "account", "", "Choose an account for this file.") };
    return { ok: true, id: account.id, name: account.name, fingerprintName: account.name };
  }
  const raw = cellAt(cells, mapping.accountColumn, cells.length).trim();
  if (raw.length === 0) return { ok: false, error: plainIssue(line, "account", raw, "Enter an account.") };
  const matched = matchByName(raw, accounts);
  if (matched.kind === "none") return { ok: false, error: plainIssue(line, "account", raw, `No account named "${raw}".`) };
  if (matched.kind === "many") {
    return { ok: false, error: plainIssue(line, "account", raw, `More than one account is named "${raw}".`) };
  }
  return { ok: true, id: matched.id, name: matched.name, fingerprintName: raw };
}

function matchByName(
  name: string,
  options: readonly { id: string; name: string }[],
): { kind: "one"; id: string; name: string } | { kind: "none" } | { kind: "many" } {
  const wanted = name.trim().toLowerCase();
  const matches = options.filter((option) => option.name.trim().toLowerCase() === wanted);
  if (matches.length === 1) return { kind: "one", id: matches[0].id, name: matches[0].name };
  if (matches.length === 0) return { kind: "none" };
  return { kind: "many" };
}

function fallbackChoice(fallback: "income" | "expense", categories: readonly ImportCategory[]): CategoryChoice {
  const name = fallback === "income" ? "Uncategorized income" : "Uncategorized";
  const existing = categories.find((item) => item.kind === fallback && item.name.trim().toLowerCase() === name.toLowerCase());
  if (existing) return { kind: "id", id: existing.id };
  return { kind: "fallback", fallback };
}

function amountIssue(line: number, raw: string, reason: "empty" | "not_number" | "zero" | "precision" | "large"): CellError {
  if (reason === "empty") return cellIssue(line, "amount", raw, "isn't a number");
  if (reason === "zero") return cellIssue(line, "amount", raw, "is zero");
  if (reason === "precision") return cellIssue(line, "amount", raw, "isn't dollars and cents");
  if (reason === "large") return cellIssue(line, "amount", raw, "is too large");
  return cellIssue(line, "amount", raw, "isn't a number");
}

function cellIssue(line: number, field: MappedField, value: string, reason: string): CellError {
  return {
    line,
    field,
    value,
    message: `Row ${line}, ${mappedTransactionSchema[field].label}: '${quote(value)}' ${reason}`,
  };
}

function plainIssue(line: number, field: MappedField, value: string, sentence: string): CellError {
  return {
    line,
    field,
    value,
    message: `Row ${line}, ${mappedTransactionSchema[field].label}: ${sentence}`,
  };
}

function quote(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function presentCells(texts: Record<MappedField, string>, errors: CellError[]): MappedCell[] {
  const byField = new Map(errors.map((error) => [error.field, error.message]));
  return FIELD_ORDER.map((field) => ({
    field,
    text: texts[field],
    message: byField.get(field) ?? null,
  }));
}

function amountRawText(cells: string[], mapping: ColumnMapping): string {
  if (mapping.amountMode === "debit_credit") {
    const debit = cellAt(cells, mapping.debitColumn, cells.length).trim();
    const credit = cellAt(cells, mapping.creditColumn, cells.length).trim();
    if (debit && credit) return `${debit} / ${credit}`;
    return debit || credit;
  }
  return cellAt(cells, mapping.amountColumn, cells.length);
}

function accountRaw(cells: string[], mapping: ColumnMapping): string {
  if (mapping.accountMode === "fixed") return "";
  return cellAt(cells, mapping.accountColumn, cells.length);
}

function cellAt(cells: string[], index: number | null, width: number): string {
  if (index == null || index < 0 || index >= width) return "";
  return cells[index] ?? "";
}

function pad(cells: string[], width: number): string[] {
  const next = cells.slice(0, width);
  while (next.length < width) next.push("");
  return next;
}

/** Fingerprints of ready rows that pair with a bank-backed row, using the same rules as bank sync. */
function alreadySynced(ready: readonly CommitCsvRow[], charges: readonly BankBackedCharge[]): Set<string> {
  if (ready.length === 0 || charges.length === 0) return new Set();
  const pairs = pairCharges(
    ready.map((row) => ({
      key: row.fingerprint,
      accountId: row.accountId,
      amountCents: row.amountCents,
      dates: [row.occurredOn],
      payee: row.payee,
    })),
    charges.map((charge) => ({
      id: charge.id,
      accountId: charge.accountId,
      amountCents: charge.amountCents,
      dates: charge.bankOccurredOn ? [charge.occurredOn, charge.bankOccurredOn] : [charge.occurredOn],
      payee: charge.payee,
      deleted: charge.deleted,
      order: charge.createdAt,
    })),
  );
  return new Set(pairs.map((pair) => pair.incomingKey));
}
