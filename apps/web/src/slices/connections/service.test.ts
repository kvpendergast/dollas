import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { disconnectBankConnection, listBankConnections, syncBankConnection, UI_ONLY_SERVICES } from "./service";

const source = readFileSync(new URL("./service.ts", import.meta.url), "utf8");

function docBefore(name: string): string {
  const at = source.indexOf(`export async function ${name}`);
  assert.notEqual(at, -1, name);
  const comment = source.slice(0, at).match(/\/\*\*(?:(?!\/\*\*)[\s\S])*?\*\/\s*$/);
  return comment?.[0] ?? "";
}

describe("bank services and MCP", () => {
  it("marks bank-login services as UI-only so MCP cannot finish a bank login", () => {
    assert.equal(UI_ONLY_SERVICES.length, 3);
    for (const fn of UI_ONLY_SERVICES) {
      const doc = docBefore(fn.name);
      assert.match(doc, /UI-only/);
      assert.match(doc, /MCP must not call this/);
    }
  });

  it("leaves list, sync, and disconnect available to MCP tools", () => {
    const reserved = new Set<unknown>(UI_ONLY_SERVICES);
    for (const fn of [listBankConnections, syncBankConnection, disconnectBankConnection]) {
      assert.equal(reserved.has(fn), false);
      const doc = docBefore(fn.name);
      assert.equal(/UI-only/.test(doc), false);
    }
  });
});
