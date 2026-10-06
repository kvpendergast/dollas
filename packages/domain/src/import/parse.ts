import { err, ok, type Result } from "neverthrow";
import { CsvImportError } from "../errors";

/** One physical CSV record. `line` is the 1-based file line where the record starts. */
export type CsvRecord = {
  line: number;
  cells: string[];
};

/**
 * RFC-style CSV: commas, quotes, doubled quotes, CR/LF, and a leading BOM.
 * A quoted field may contain commas and line breaks. Quotes that do not wrap
 * a whole field are rejected. Blank lines are skipped.
 */
export function parseCsvTable(raw: string): Result<CsvRecord[], CsvImportError> {
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
