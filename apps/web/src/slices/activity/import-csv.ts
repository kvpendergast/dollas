"use server";

import { CSV_IMPORT_MAX_CHARS, csvTooLargeMessage, formatCents, type CsvInspection, type DateOrder, type ColumnMapping } from "@dollas/domain";
import { revalidatePath } from "next/cache";
import { requireBooks } from "@/slices/access/guard";
import {
  commitCsvImport,
  inspectCsvImport,
  listCsvImports,
  previewCsvImport,
  undoCsvImport,
  type CsvPreview,
  type OpenCsvImport,
} from "./csv-import-service";

/**
 * Thin form wrappers for the import panel. Parsing, mapping, validation,
 * commit, and undo live in ./csv-import-service, which MCP tools call too.
 */

export type ImportInspection = CsvInspection;

export type ImportPreviewCell = {
  field: string;
  text: string;
  message: string | null;
};

export type ImportPreviewRow = {
  line: number;
  status: "ready" | "error" | "duplicate";
  duplicateOf: "import" | "bank" | null;
  cells: ImportPreviewCell[];
};

export type ImportPreview = {
  stamp: string;
  readyCount: number;
  errorCount: number;
  duplicateCount: number;
  rows: ImportPreviewRow[];
};

export type ImportStage = "upload" | "map" | "preview";

export type ImportCsvState = {
  error: string;
  message: string;
  stage: ImportStage;
  stamp: string;
  inspection: ImportInspection | null;
  preview: ImportPreview | null;
};

export type UndoImportState = { error: string; message: string };

export type { OpenCsvImport };

const initialState: ImportCsvState = {
  error: "",
  message: "",
  stage: "upload",
  stamp: "",
  inspection: null,
  preview: null,
};

export async function importCsvAction(_state: ImportCsvState, formData: FormData): Promise<ImportCsvState> {
  const intent = String(formData.get("intent") ?? "inspect");
  if (intent === "commit") return commitCsv(formData);
  if (intent === "preview") return previewCsv(formData);
  return inspectCsv(formData);
}

export async function undoCsvImportAction(_state: UndoImportState, formData: FormData): Promise<UndoImportState> {
  const books = await requireBooks();
  const undone = await undoCsvImport(books, String(formData.get("batchId") ?? ""));
  if (!undone.ok) return { error: undone.memberMessage, message: "" };
  revalidateBooks();
  return { error: "", message: undone.value.message };
}

export type CsvImportPanel = {
  open: OpenCsvImport[];
  undoneNotice: string;
};

export async function loadCsvImportPanel(): Promise<CsvImportPanel> {
  const books = await requireBooks();
  const listed = await listCsvImports(books);
  if (!listed.ok) throw new Error(listed.memberMessage);
  return listed.value;
}

async function inspectCsv(formData: FormData): Promise<ImportCsvState> {
  const books = await requireBooks();
  const file = await readCsvFile(formData);
  if ("error" in file) return { ...initialState, error: file.error, stamp: fileStamp(formData) };
  const inspected = await inspectCsvImport(books, { csv: file.text, hasHeader: headerChoice(formData) });
  if (!inspected.ok) return { ...initialState, error: inspected.memberMessage, stamp: file.stamp };
  const { inspection, preview, previewError } = inspected.value;
  return {
    error: previewError,
    message: "",
    stage: preview ? "preview" : "map",
    stamp: file.stamp,
    inspection,
    preview: preview ? presentPreview(preview, file.stamp) : null,
  };
}

async function previewCsv(formData: FormData): Promise<ImportCsvState> {
  const books = await requireBooks();
  const file = await readCsvFile(formData);
  if ("error" in file) return { ...initialState, error: file.error, stamp: fileStamp(formData) };
  const previewed = await previewCsvImport(books, { csv: file.text, mapping: readMapping(formData) });
  if (!previewed.ok) return { ...initialState, error: previewed.memberMessage, stamp: file.stamp };
  const view = previewed.value;
  if (view.kind === "mapping_error") {
    return { error: view.message, message: "", stage: "map", stamp: file.stamp, inspection: view.inspection, preview: null };
  }
  return {
    error: "",
    message: "",
    stage: "preview",
    stamp: file.stamp,
    inspection: view.inspection,
    preview: presentPreview(view.preview, file.stamp),
  };
}

async function commitCsv(formData: FormData): Promise<ImportCsvState> {
  const books = await requireBooks();
  const file = await readCsvFile(formData);
  if ("error" in file) return { ...initialState, error: file.error, stamp: fileStamp(formData) };
  const committed = await commitCsvImport(books, { csv: file.text, mapping: readMapping(formData) });
  if (!committed.ok) return { ...initialState, error: committed.memberMessage, stamp: file.stamp };
  revalidateBooks();
  return { ...initialState, message: committed.value.message, stamp: file.stamp };
}

async function readCsvFile(formData: FormData): Promise<{ error: string } | { text: string; stamp: string }> {
  const file = formData.get("csv");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a CSV file." };
  if (file.size > CSV_IMPORT_MAX_CHARS) return { error: csvTooLargeMessage() };
  const text = await file.text();
  if (text.length > CSV_IMPORT_MAX_CHARS) return { error: csvTooLargeMessage() };
  return { text, stamp: fileStamp(formData) };
}

function fileStamp(formData: FormData): string {
  return String(formData.get("stamp") ?? "").slice(0, 500);
}

function headerChoice(formData: FormData): boolean | undefined {
  if (!formData.has("hasHeader")) return undefined;
  return formData.get("hasHeader") === "1";
}

function readMapping(formData: FormData): ColumnMapping {
  const dateOrderRaw = String(formData.get("dateOrder") ?? "");
  const fixedAccountId = String(formData.get("fixedAccountId") ?? "").trim();
  return {
    hasHeader: formData.get("hasHeader") === "1",
    dateColumn: optionalIndex(formData, "dateColumn"),
    payeeColumn: optionalIndex(formData, "payeeColumn"),
    amountMode: formData.get("amountMode") === "debit_credit" ? "debit_credit" : "signed",
    amountColumn: optionalIndex(formData, "amountColumn"),
    debitColumn: optionalIndex(formData, "debitColumn"),
    creditColumn: optionalIndex(formData, "creditColumn"),
    flipSign: formData.get("flipSign") === "1",
    dateOrder: isDateOrder(dateOrderRaw) ? dateOrderRaw : null,
    accountMode: formData.get("accountMode") === "column" ? "column" : "fixed",
    accountColumn: optionalIndex(formData, "accountColumn"),
    fixedAccountId: fixedAccountId.length > 0 ? fixedAccountId : null,
    categoryColumn: optionalIndex(formData, "categoryColumn"),
    notesColumn: optionalIndex(formData, "notesColumn"),
  };
}

function isDateOrder(value: string): value is DateOrder {
  return value === "ymd" || value === "mdy" || value === "dmy";
}

function optionalIndex(formData: FormData, name: string): number | null {
  const raw = String(formData.get(name) ?? "");
  if (raw.length === 0) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 63) return null;
  return value;
}

function presentPreview(outcome: CsvPreview, stamp: string): ImportPreview {
  return {
    stamp,
    readyCount: outcome.readyCount,
    errorCount: outcome.errorCount,
    duplicateCount: outcome.duplicateCount,
    rows: outcome.rows.map((row) => ({
      line: row.line,
      status: row.status,
      duplicateOf: row.duplicateOf,
      cells: row.cells.map((cell) => ({
        field: cell.field,
        text: cell.field === "amount" && row.amountCents != null && cell.message == null ? formatCents(row.amountCents) : cell.text,
        message: cell.message,
      })),
    })),
  };
}

function revalidateBooks() {
  revalidatePath("/activity");
  revalidatePath("/");
  revalidatePath("/plan");
  revalidatePath("/history");
  revalidatePath("/estimate");
}
