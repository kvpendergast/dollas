import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Cheap guard (shadcn standardization, PEN-311): screens compose the shared components. Native
 * select/textarea/table/details/button, checkbox/radio/file inputs, and raw hex colours live only
 * in components/ui (the primitives). Everything else uses the primitives and the colour tokens.
 */
const root = path.resolve(__dirname, "../..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return files(full);
    return /\.(tsx|ts)$/.test(name) && !/\.(vitest|test)\./.test(name) ? [full] : [];
  });
}

const sources = files(path.join(root, "src"))
  .filter((file) => !file.includes(`${path.sep}components${path.sep}ui${path.sep}`))
  .map((file) => ({ file: path.relative(root, file), text: readFileSync(file, "utf8") }));

function offenders(pattern: RegExp, allow: string[] = []): string[] {
  return sources.filter((source) => !allow.includes(source.file) && pattern.test(source.text)).map((source) => source.file);
}

describe("UI standardization guard", () => {
  it("has no native select, textarea, table, details or button outside components/ui", () => {
    expect(offenders(/<(select|textarea|table|details|button)[\s>]/)).toEqual([]);
  });

  it("has no native checkbox, radio or file inputs outside components/ui", () => {
    expect(offenders(/<input[^>]*type=["'](checkbox|radio|file)["']/)).toEqual([]);
  });

  it("has no raw hex colours in components or pages (the theme-color meta is the one literal)", () => {
    expect(offenders(/["'`]#[0-9a-fA-F]{3,8}["'`]/, ["src/app/layout.tsx"])).toEqual([]);
  });
});
