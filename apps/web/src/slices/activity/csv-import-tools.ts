import { CSV_IMPORT_MAX_CHARS, labelKey, type ColumnMapping, type CsvInspection } from "@dollas/domain";
import { confirmInput, pageInput, paginate, readPage } from "@dollas/mcp";
import { z } from "zod";
import { answer, plural, tool, uuidInput } from "@/slices/agents/tool-kit";
import type { AgentToolContext } from "@/slices/agents/tool-kit";
import { loadStagedCsv, stageCsvUpload } from "./csv-upload-service";
import {
  commitCsvImport,
  csvCategoryLabels,
  inspectCsvImport,
  listCsvImports,
  previewCsvImport,
  undoCsvImport,
  type CsvPreview,
} from "./csv-import-service";

const column = z.number().int().min(0).max(63).nullable().describe("Zero-based column index, or null.");

const csvFields = {
  upload_id: z
    .string()
    .uuid()
    .optional()
    .describe("Id from stage_csv. Preferred: stage the file once and pass this to every step."),
  csv: z
    .string()
    .min(1)
    .max(CSV_IMPORT_MAX_CHARS)
    .optional()
    .describe(`The CSV text (up to ${CSV_IMPORT_MAX_CHARS} characters), when you did not stage it. Give upload_id or csv, not both.`),
};

type CsvArgs = { upload_id?: string; csv?: string };

/** The file text for a step: the staged upload, or the pasted text. Exactly one is required. */
async function csvFor(
  args: CsvArgs,
  books: AgentToolContext["books"],
): Promise<{ ok: true; csv: string; sha256: string | null } | { ok: false; message: string }> {
  if (args.upload_id && args.csv) return { ok: false, message: "Give upload_id or csv, not both." };
  if (args.upload_id) {
    const staged = await loadStagedCsv(books, args.upload_id);
    return staged.ok ? { ok: true, csv: staged.value.csv, sha256: staged.value.sha256 } : { ok: false, message: staged.memberMessage };
  }
  if (args.csv) return { ok: true, csv: args.csv, sha256: null };
  return { ok: false, message: "Give upload_id (from stage_csv) or csv." };
}

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

const categoryHandlingFields = {
  unmatched_categories: z
    .enum(["error", "uncategorized", "create"])
    .optional()
    .describe(
      "What to do with a category label that matches no Dollas category. error (default): the row is an error. uncategorized: import it as Uncategorized (ignores the label). create: make a new category named after the label (income or expense by the row's sign).",
    ),
  category_map: z
    .record(z.string().max(200), z.string().uuid())
    .optional()
    .describe("Map bank labels to existing category ids, e.g. {\"Dining\": \"<category id>\"}. Wins over unmatched_categories. Use list_csv_category_labels to see the labels."),
};

function categoriesIn(args: { unmatched_categories?: "error" | "uncategorized" | "create"; category_map?: Record<string, string> }) {
  const map: Record<string, string> = {};
  for (const [label, id] of Object.entries(args.category_map ?? {})) map[labelKey(label)] = id;
  return { unmatched: args.unmatched_categories, categoryMap: map };
}

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
  const wanted = args.rows === "all" ? preview.rows : preview.rows.filter((row) => row.status !== "ready" || row.possibleTransfer);
  return {
    ready_count: preview.readyCount,
    error_count: preview.errorCount,
    duplicate_count: preview.duplicateCount,
    possible_transfer_count: preview.possibleTransferCount,
    rows: paginate(
      wanted.map((row) => ({
        line: row.line,
        status: row.status,
        duplicate_of: row.duplicateOf,
        possible_transfer: row.possibleTransfer,
        amount_cents: row.amountCents,
        cells: row.cells.map((cell) => ({ field: cell.field, text: cell.text, error: cell.message })),
      })),
      readPage(args, 50),
    ),
  };
}

function previewSummary(preview: CsvPreview): string {
  const transfers =
    preview.possibleTransferCount > 0
      ? ` ${plural(preview.possibleTransferCount, "ready row")} look like transfers or card payments (possible_transfer): importing them counts that money twice. Leave them out, or record them with create_transfer.`
      : "";
  return `${plural(preview.readyCount, "row")} ready, ${plural(preview.errorCount, "row")} with errors, ${plural(preview.duplicateCount, "duplicate")}.${transfers}`;
}

const rowsInput = {
  rows: z.enum(["problems", "all"]).optional().describe("Which rows to list: only rows with errors, duplicates or a possible_transfer flag (default), or all."),
  ...pageInput(50),
};

export const csvImportTools = [
  tool({
    name: "stage_csv",
    title: "Stage CSV",
    description: `Step 0 of a CSV import. Upload the file's text once and get an upload_id for inspect_csv, preview_csv_import and commit_csv_import, so the file is never pasted again. The staged file is immutable, kept 24 hours, and its sha256 is returned so you can confirm the bytes. Nothing is imported yet.`,
    access: "write",
    input: { csv: z.string().min(1).max(CSV_IMPORT_MAX_CHARS).describe(`The CSV file's full text (up to ${CSV_IMPORT_MAX_CHARS} characters).`) },
    async run(args, { books }) {
      return answer(
        await stageCsvUpload(books, args.csv),
        (value) => `Staged ${plural(value.lineCount, "line")}. Pass upload_id to the next steps.`,
        (value) => ({
          upload_id: value.id,
          sha256: value.sha256,
          chars: value.charCount,
          lines: value.lineCount,
          expires_at: value.expiresAt,
        }),
      );
    },
  }),
  tool({
    name: "inspect_csv",
    title: "Inspect CSV",
    description:
      "Step 1 of a CSV import. Reads the file and proposes a column mapping. When a mapping saved from an earlier import fits, it also validates right away. Nothing is written.",
    access: "read",
    input: { ...csvFields, has_header: z.boolean().optional().describe("Override whether the first row is a header.") },
    async run(args, { books }) {
      const file = await csvFor(args, books);
      if (!file.ok) return file;
      const inspected = await inspectCsvImport(books, { csv: file.csv, hasHeader: args.has_header });
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
      "Step 2. Validates every row against the mapping and returns cell-level errors (field, text, error) and the ready, error, and duplicate counts. A duplicate is a row already imported (duplicate_of: import) or a charge bank sync already added on the same account, same amount, within 3 days (duplicate_of: bank). Nothing is written.",
    access: "read",
    input: { ...csvFields, mapping: mappingInput, ...categoryHandlingFields, ...rowsInput },
    async run(args, { books }) {
      const file = await csvFor(args, books);
      if (!file.ok) return file;
      const previewed = await previewCsvImport(books, { csv: file.csv, mapping: mappingIn(args.mapping), categories: categoriesIn(args) });
      if (previewed.ok && previewed.value.kind === "mapping_error") return { ok: false, message: previewed.value.message };
      return answer(
        previewed,
        (value) => (value.kind === "preview" ? previewSummary(value.preview) : ""),
        (value) => (value.kind === "preview" ? previewOut(value.preview, args) : null),
      );
    },
  }),
  tool({
    name: "list_csv_category_labels",
    title: "List CSV category labels",
    description:
      "Between inspect and commit. Lists the distinct category labels in the file with row counts and totals, and which already match a Dollas category by name. Use it to build category_map or choose unmatched_categories. Nothing is written.",
    access: "read",
    input: { ...csvFields, mapping: mappingInput, ...pageInput(100) },
    async run(args, { books }) {
      const file = await csvFor(args, books);
      if (!file.ok) return file;
      return answer(
        await csvCategoryLabels(books, { csv: file.csv, mapping: mappingIn(args.mapping) }),
        (value) => `${plural(value.length, "label")}, ${value.filter((item) => !item.matchedCategoryId).length} without a matching category.`,
        (value) =>
          paginate(
            value.map((item) => ({
              label: item.label,
              rows: item.rows,
              total_cents: item.totalCents,
              matched_category_id: item.matchedCategoryId,
              matched_category_name: item.matchedCategoryName,
              ambiguous: item.ambiguous,
            })),
            readPage(args, 100),
          ),
      );
    },
  }),
  tool({
    name: "commit_csv_import",
    title: "Commit CSV import",
    description:
      "Step 3. Writes the ready rows as one import and remembers the mapping for next time. Rows with errors and duplicates are skipped. Set unmatched_categories or category_map first if the file has bank category labels Dollas does not know. undo_csv_import reverses it.",
    access: "write",
    input: { ...csvFields, mapping: mappingInput, ...categoryHandlingFields },
    async run(args, { books }) {
      const file = await csvFor(args, books);
      if (!file.ok) return file;
      const committed = await commitCsvImport(books, { csv: file.csv, mapping: mappingIn(args.mapping), categories: categoriesIn(args) }, "mcp");
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
    description: "Remove the transactions an import added and mark it undone. Transactions a bank sync has since matched are kept (the bank backs them) and detached from the import. The file can be imported again.",
    access: "write",
    destructive: true,
    input: { import_id: uuidInput("Import"), confirm: confirmInput("remove the transactions this import added") },
    async run(args, { books }) {
      return answer(await undoCsvImport(books, args.import_id, "mcp"), (value) => value.message);
    },
  }),
];
