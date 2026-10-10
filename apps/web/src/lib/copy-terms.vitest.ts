import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo, scanSource } from "./copy-terms";

describe("one name for the household (PEN-204)", () => {
  it("flags the old terms in sentences, JSX text, and visible attributes", () => {
    const found = scanSource(
      "x.tsx",
      [
        'const a = "Same books, separate logins.";',
        "const b = <p>One pile of dollas.</p>;",
        'const c = <nav aria-label="Books" />;',
        "const d = `Join the ${name} books`;",
      ].join("\n"),
    );
    expect(found.map((row) => [row.line, row.term])).toEqual([
      [1, "books"],
      [2, "pile"],
      [2, "dollas"],
      [3, "books"],
      [4, "books"],
    ]);
  });

  it("ignores code: imports, identifiers, template expressions, machine strings, and the wordmark", () => {
    const found = scanSource(
      "x.tsx",
      [
        'import { loadHome } from "@/slices/books/queries";',
        'const mod = await import("@/slices/books/estimate");',
        "const s = `Spent ${money(cents, books)} this month.`;",
        'logInfo("x", { action: "load-books" });',
        'const role = "dollas_app";',
        "const mark = <p>dollas</p>;",
        'const name = "Dollas, for two";',
        'const route = "/(books)/activity";',
        "function f(books: BooksContext) { return books.householdId; }",
      ].join("\n"),
    );
    expect(found).toEqual([]);
  });

  it("no user-facing copy in the app, domain, or MCP uses the old terms", () => {
    const findings = scanRepo(path.resolve(__dirname, "../../../.."));
    expect(findings.map((row) => `${row.file}:${row.line} "${row.term}": ${row.text}`)).toEqual([]);
  });
});
