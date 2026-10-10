import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const credentials = readFileSync(new URL("./credentials.ts", import.meta.url), "utf8");
const membership = readFileSync(new URL("./membership.ts", import.meta.url), "utf8");

function docBefore(source: string, name: string): string {
  const at = source.indexOf(`export async function ${name}`);
  assert.notEqual(at, -1, name);
  const comment = source.slice(0, at).match(/\/\*\*(?:(?!\/\*\*)[\s\S])*?\*\/\s*$/);
  return comment?.[0] ?? "";
}

describe("credential changes stay out of MCP", () => {
  it("marks email and password changes as UI-only", () => {
    for (const name of ["changeMemberEmail", "changeMemberPassword"]) {
      const doc = docBefore(credentials, name);
      assert.match(doc, /UI-only/);
      assert.match(doc, /MCP must not call this/);
    }
    assert.match(credentials, /UI_ONLY_CREDENTIALS/);
  });

  it("keeps passwords and email changes out of the membership service", () => {
    assert.equal(membership.includes("changeMemberEmail"), false);
    assert.equal(membership.includes("changeMemberPassword"), false);
    assert.equal(membership.includes("changePassword"), false);
    assert.equal(membership.includes("changeEmail"), false);
    assert.equal(membership.includes("newPassword"), false);
    assert.equal(membership.includes("currentPassword"), false);
    assert.match(membership, /MCP tools call this too/);
  });
});
