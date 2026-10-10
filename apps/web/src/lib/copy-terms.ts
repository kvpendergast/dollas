import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

/**
 * One user-facing name for the shared books (PEN-204): "household". This
 * scans literal text only (JSX text, string and template literal text, and
 * user-visible JSX attributes), never identifiers, imports, or the
 * expressions inside a template, so a `books` variable or the (books) route
 * group is fine. "Dollas" stays as the product name; lowercase "dollas" is
 * allowed only as the wordmark on its own.
 */

export const FORBIDDEN_TERMS: ReadonlyArray<{ term: string; pattern: RegExp; hint: string }> = [
  { term: "books", pattern: /\bbooks\b/i, hint: 'Say "household" (or name the thing: transactions, totals).' },
  { term: "pile", pattern: /\bpile\b/i, hint: 'Say "household".' },
  { term: "dollas", pattern: /\bdollas\b/, hint: 'Write the product name as "Dollas", or say "money" or "transactions".' },
];

const VISIBLE_ATTRIBUTES = new Set(["aria-label", "title", "placeholder", "alt", "label", "aria-description"]);

export type CopyFinding = { file: string; line: number; term: string; text: string; hint: string };

function check(text: string, always: boolean): Array<{ term: string; hint: string }> {
  const trimmed = text.trim();
  if (trimmed === "dollas") return []; // the wordmark
  // Machine strings (paths, keys, log actions) have no spaces; sentences do.
  if (!always && !/\s/.test(text)) return [];
  return FORBIDDEN_TERMS.filter((rule) => rule.pattern.test(text)).map(({ term, hint }) => ({ term, hint }));
}

export function scanSource(file: string, source: string): CopyFinding[] {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const findings: CopyFinding[] = [];
  const lines = source.split("\n");
  const report = (node: ts.Node, text: string, always = false) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    // A machine string that happens to match (e.g. a hashing label) opts out with a comment on its line or the one above.
    if (/copy-terms-ignore/.test(lines[line] ?? "") || /copy-terms-ignore/.test(lines[line - 1] ?? "")) return;
    for (const hit of check(text, always)) {
      findings.push({ file, line: line + 1, term: hit.term, text: text.trim().slice(0, 120), hint: hit.hint });
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) return;
    if (ts.isJsxText(node)) report(node, node.text, true);
    else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sf);
      if (node.initializer && ts.isStringLiteral(node.initializer)) {
        if (VISIBLE_ATTRIBUTES.has(name)) report(node.initializer, node.initializer.text, true);
        return;
      }
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) report(node, node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) report(node, node.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

function walk(dir: string, out: string[]) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|vitest)\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
}

/**
 * Directories with copy members or agents can see. src/db (deployer-facing
 * migration and startup messages) and scripts are out of scope.
 */
export function scanRepo(root: string): CopyFinding[] {
  const dirs = ["apps/web/src/app", "apps/web/src/components", "apps/web/src/slices", "apps/web/src/lib", "packages/domain/src", "packages/mcp/src"];
  const files: string[] = [];
  for (const dir of dirs) walk(path.join(root, dir), files);
  return files
    .filter((file) => !file.endsWith(path.join("lib", "copy-terms.ts")))
    .flatMap((file) => scanSource(path.relative(root, file), readFileSync(file, "utf8")));
}
