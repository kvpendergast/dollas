import { CSV_IMPORT_MAX_CHARS, type ColumnMapping, type CsvInspection } from "@dollas/domain";
import { confirmInput, pageInput, paginate, readPage } from "@dollas/mcp";
import { z } from "zod";
import { answer, plural, tool, uuidInput } from "@/slices/agents/tool-kit";
import {
  commitCsvImport,
  inspectCsvImport,
  listCsvImports,
  previewCsvImport,
  undoCsvImport,
  type CsvPreview,
} from "./csv-import-service";

const column = z.number().int().min(0).max(63).nullable().describe("Zero-based column index, or null.");

const csvInput = z
  .string()
  .min(1)
  .max(CSV_IMPORT_MAX_CHARS)
  .describe(`The CSV file's full text (up to ${CSV_IMPORT_MAX_CHARS} characters). Send the same text to every step.`);

const mappingInput = z
  .object({
    has_header: z.boolean(),
    date_column: column,
    payee_column: column,
    amount_mode: z.enum(["signed", "debit_credit"]).describe("One signed amount column, or separate debit and credit columns."),
    amount_column: column,
    debit_column: column,
    credit_column: column,
    flip_sign: z.boolean().describe("Flip the sign when the bank shows spending as positive."),
    date_order: z.enum(["ymd", "mdy", "dmy"]).nullable().describe("Needed when dates like 03/04/2026 are ambiguous."),
    account_mode: z.enum(["fixed", "column"]).describe("One Dollas account for the file, or an account-name column."),
    account_column: column,
    fixed_account_id: z.string().uuid().nullable().describe("The Dollas account when account_mode is fixed."),
    category_column: column,
    notes_column: column,
  })
  .describe("Column mapping. Start from the mapping inspect_csv proposes and change only what is wrong.");

type MappingArgs = z.infer<typeof mappingInput>;

function mappingIn(args: MappingArgs): ColumnMapping {
  return {
    hasHeader: args.has_header,
    dateColumn: args.date_column,
    payeeColumn: args.payee_column,
    amountMode: args.amount_mode,
    amountColumn: args.amount_column,
    debitColumn: args.debit_column,
    creditColumn: args.credit_column,
    flipSign: args.flip_sign,
    dateOrder: args.date_order,
    accountMode: args.account_mode,
    accountColumn: args.account_column,
    fixedAccountId: args.fixed_account_id,
    categoryColumn: args.category_column,
    notesColumn: args.notes_column,
  };
}

export function mappingOut(mapping: ColumnMapping): MappingArgs {
  return {
    has_header: mapping.hasHeader,
    date_column: mapping.dateColumn,
    payee_column: mapping.payeeColumn,
    amount_mode: mapping.amountMode,
    amount_column: mapping.amountColumn,
    debit_column: mapping.debitColumn,
    credit_column: mapping.creditColumn,
    flip_sign: mapping.flipSign,
    date_order: mapping.dateOrder,
    account_mode: mapping.accountMode,
    account_column: mapping.accountColumn,
    fixed_account_id: mapping.fixedAccountId,
    category_column: mapping.categoryColumn,
    notes_column: mapping.notesColumn,
  };
}

function inspectionOut(inspection: CsvInspection) {
  return {
    has_header: inspection.hasHeader,
    columns: inspection.columns,
    sample_rows: inspection.sampleRows.slice(0, 5),
    proposed_mapping: mappingOut(inspection.mapping),
    date_order_ambiguous: inspection.dateOrderAmbiguous,
    reused_saved_mapping: inspection.reusedSavedMapping,
  };
}

function previewOut(preview: CsvPreview, args: { rows?: "problems" | "all"; limit?: number; cursor?: string }) {
  const wanted = args.rows === "all" ? preview.rows : preview.rows.filter((row) => row.status !== "ready");
  return {
    ready_count: preview.readyCount,
    error_count: preview.errorCount,
    duplicate_count: preview.duplicateCount,
    rows: paginate(
      wanted.map((row) => ({
        line: row.line,
        status: row.status,
        amount_cents: row.amountCents,
        cells: row.cells.map((cell) => ({ field: cell.field, text: cell.text, error: cell.message })),
      })),
      readPage(args, 50),
    ),
  };
}

function previewSummary(preview: CsvPreview): string {
  return `${plural(preview.readyCount, "row")} ready, ${plural(preview.errorCount, "row")} with errors, ${plural(preview.duplicateCount, "duplicate")}.`;
}

const rowsInput = {
  rows: z.enum(["problems", "all"]).optional().describe("Which rows to list: only rows with errors or duplicates (default), or all."),
  ...pageInput(50),
};

export const csvImportTools = [
  tool({
    name: "inspect_csv",
    title: "Inspect CSV",
    description:
      "Step 1 of a CSV import. Reads the file and proposes a column mapping. When a mapping saved from an earlier import fits, it also validates right away. Nothing is written.",
    access: "read",
    input: { csv: csvInput, has_header: z.boolean().optional().describe("Override whether the first row is a header.") },
    async run(args, { books }) {
      const inspected = await inspectCsvImport(books, { csv: args.csv, hasHeader: args.has_header });
      return answer(
        inspected,
        (value) =>
          value.preview
            ? `Reused a saved mapping. ${previewSummary(value.preview)}`
            : `Found ${plural(value.inspection.columns.length, "column")}. Check the proposed mapping, then call preview_csv_import.`,
        (value) => ({
          inspection: inspectionOut(value.inspection),
          preview: value.preview ? previewOut(value.preview, {}) : null,
          preview_error: value.previewError || null,
        }),
      );
    },
  }),
  tool({
    name: "preview_csv_import",
    title: "Preview CSV import",
    description:
      "Step 2. Validates every row against the mapping and returns cell-level errors (field, text, error) and the ready, error, and duplicate counts. Nothing is written.",
    access: "read",
    input: { csv: csvInput, mapping: mappingInput, ...rowsInput },
    async run(args, { books }) {
      const previewed = await previewCsvImport(books, { csv: args.csv, mapping: mappingIn(args.mapping) });
      if (previewed.ok && previewed.value.kind === "mapping_error") return { ok: false, message: previewed.value.message };
      return answer(
        previewed,
        (value) => (value.kind === "preview" ? previewSummary(value.preview) : ""),
        (value) => (value.kind === "preview" ? previewOut(value.preview, args) : null),
      );
    },
  }),
  tool({
    name: "commit_csv_import",
    title: "Commit CSV import",
    description:
      "Step 3. Writes the ready rows as one import and remembers the mapping for next time. Rows with errors and duplicates are skipped. undo_csv_import reverses it.",
    access: "write",
    input: { csv: csvInput, mapping: mappingInput },
    async run(args, { books }) {
      const committed = await commitCsvImport(books, { csv: args.csv, mapping: mappingIn(args.mapping) }, "mcp");
      return answer(committed, (value) => value.message, (value) => ({
        import_id: value.batchId,
        added: value.added,
        error_count: value.errorCount,
        duplicate_count: value.duplicateCount,
      }));
    },
  }),
  tool({
    name: "list_csv_imports",
    title: "List CSV imports",
    description: "Imports that can still be undone, newest first, with how many transactions each added.",
    access: "read",
    input: { ...pageInput(25) },
    async run(args, { books }) {
      return answer(
        await listCsvImports(books),
        (value) => `${plural(value.open.length, "import")} can be undone.`,
        (value) => ({
          ...paginate(
            value.open.map((item) => ({ import_id: item.id, added: item.addedCount, created_at: item.createdAt })),
            readPage(args, 25),
          ),
          notice: value.undoneNotice || null,
        }),
      );
    },
  }),
  tool({
    name: "undo_csv_import",
    title: "Undo CSV import",
    description: "Remove the transactions an import added and mark it undone. Transactions edited since the import are kept. The file can be imported again.",
    access: "write",
    destructive: true,
    input: { import_id: uuidInput("Import"), confirm: confirmInput("remove the transactions this import added") },
    async run(args, { books }) {
      return answer(await undoCsvImport(books, args.import_id, "mcp"), (value) => value.message);
    },
  }),
];
