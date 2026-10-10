import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, it } from "node:test";
import { ACTION_PARITY, AGENT_ONLY_TOOLS, PAGE_PARITY, type Parity } from "@/slices/parity";
import { DOLLAS_TOOLS } from "./tools";

/**
 * CI-enforced parity between the web app and MCP. See src/slices/parity.ts.
 */

const SRC = join(__dirname, "..", "..");
const APP = join(SRC, "app");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const sources = walk(SRC).filter((path) => /\.(ts|tsx)$/.test(path) && !/\.test\.tsx?$/.test(path));
const serverFiles = sources.filter((path) => /^\s*["']use server["'];?/.test(readFileSync(path, "utf8")));

function exportedActions(path: string): string[] {
  const text = readFileSync(path, "utf8");
  return [...text.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|var)\s+([A-Za-z0-9_$]+)/gm)].map((match) => match[1] as string);
}

function routeOf(pagePath: string): string {
  const parts = relative(APP, pagePath)
    .split(sep)
    .slice(0, -1)
    .filter((part) => !/^\(.*\)$/.test(part));
  return `/${parts.join("/")}`;
}

const pages = walk(APP).filter((path) => path.endsWith(`${sep}page.tsx`));
const toolNames = new Set(DOLLAS_TOOLS.map((item) => item.name));

function check(label: string, entry: Parity) {
  if ("uiOnly" in entry) {
    assert.ok(entry.uiOnly.trim().length >= 20, `${label}: a UI-only exemption needs a real reason`);
    return;
  }
  assert.ok(entry.tools.length > 0, `${label}: list at least one tool, or mark it uiOnly with a reason`);
  for (const name of entry.tools) assert.ok(toolNames.has(name), `${label}: no MCP tool named ${name}`);
}

describe("UI and MCP parity", () => {
  it("finds the server actions and pages it checks", () => {
    assert.ok(serverFiles.length >= 10, `found only ${serverFiles.length} "use server" files`);
    assert.ok(pages.length >= 9, `found only ${pages.length} pages`);
  });

  it("maps every exported server action to MCP tools or a UI-only reason", () => {
    const found = new Map<string, string>();
    for (const file of serverFiles) {
      for (const name of exportedActions(file)) {
        assert.ok(!found.has(name), `${name} is exported from two server files; give one a distinct name`);
        found.set(name, relative(SRC, file));
      }
    }
    for (const [name, file] of found) {
      const entry = ACTION_PARITY[name];
      assert.ok(entry, `${file} exports server action ${name} with no entry in src/slices/parity.ts. Add an MCP tool that calls the same service, or mark it uiOnly with a reason.`);
      check(name, entry);
    }
    for (const name of Object.keys(ACTION_PARITY)) {
      assert.ok(found.has(name), `parity.ts lists ${name}, but no "use server" file exports it. Remove the stale entry.`);
    }
  });

  it("maps every page to read tools or a UI-only reason", () => {
    const routes = new Set(pages.map(routeOf));
    for (const route of routes) {
      const entry = PAGE_PARITY[route];
      assert.ok(entry, `page ${route} has no entry in PAGE_PARITY (src/slices/parity.ts)`);
      check(route, entry);
    }
    for (const route of Object.keys(PAGE_PARITY)) assert.ok(routes.has(route), `PAGE_PARITY lists ${route}, but there is no such page`);
  });

  it("reaches every MCP tool from an action, a page, or an agent-only reason", () => {
    const referenced = new Set<string>();
    for (const entry of [...Object.values(ACTION_PARITY), ...Object.values(PAGE_PARITY)]) {
      if ("tools" in entry) for (const name of entry.tools) referenced.add(name);
    }
    for (const name of toolNames) {
      assert.ok(
        referenced.has(name) || Object.hasOwn(AGENT_ONLY_TOOLS, name),
        `tool ${name} is not mapped from any action or page; add it to parity.ts or AGENT_ONLY_TOOLS with a reason`,
      );
    }
    for (const [name, reason] of Object.entries(AGENT_ONLY_TOOLS)) {
      assert.ok(toolNames.has(name), `AGENT_ONLY_TOOLS lists ${name}, which is not a tool`);
      assert.ok(reason.trim().length >= 20, `${name}: an agent-only tool needs a real reason`);
    }
  });

  it("keeps logic out of server action files", () => {
    for (const file of serverFiles) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(
        text,
        /from\s+["'](?:drizzle-orm|@\/db\/[^"']*)["']/,
        `${relative(SRC, file)} queries the database. Move that into the slice's service so the MCP tool can call it too.`,
      );
    }
  });

  it("registers every slice tools file on the MCP endpoint", () => {
    const registry = readFileSync(join(__dirname, "tools.ts"), "utf8");
    const toolFiles = sources.filter((path) => /[/\\]slices[/\\][^/\\]+[/\\](?:[a-z-]+-)?tools\.ts$/.test(path) && !path.endsWith(`agents${sep}tools.ts`));
    assert.ok(toolFiles.length >= 8);
    for (const file of toolFiles) {
      const specifier = `@/${relative(SRC, file).split(sep).join("/").replace(/\.ts$/, "")}`;
      assert.ok(registry.includes(`"${specifier}"`), `${specifier} is not imported by src/slices/agents/tools.ts`);
    }
  });

  it("guards destructive tools with confirm and gives each a clear description", () => {
    const mustConfirm = ["delete_transaction", "delete_household", "undo_csv_import", "leave_household", "delete_account", "transfer_ownership", "disconnect_bank_connection", "delete_payee_rule"];
    for (const name of mustConfirm) {
      const found = DOLLAS_TOOLS.find((item) => item.name === name);
      assert.ok(found?.destructive, `${name} must be destructive and take confirm`);
      assert.ok("confirm" in (found?.input ?? {}), `${name} must take confirm`);
    }
    for (const item of DOLLAS_TOOLS) {
      if (/^(delete|undo|leave|remove|disconnect)_/.test(item.name) && item.name !== "remove_category_group") {
        assert.ok(item.destructive, `${item.name} sounds destructive; mark it destructive with confirm`);
      }
      if (item.access === "read") assert.ok(!item.destructive, `${item.name} is read-only and cannot be destructive`);
    }
  });
});
