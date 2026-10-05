import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactLogAttributes, redactSecrets } from "./redact";

describe("redact", () => {
  it("drops token attributes and sealed ciphertext from log fields", () => {
    const ciphertext = "v2.AAAAAAAAAAAAAAAA.CCCCCCCCCCCCCCCCCCCCCCCC";
    const token = "simplefin-access-url-SECRET-value";
    const fields = redactLogAttributes({
      action: "disconnect-bank",
      householdId: "house-a",
      connectionId: "connection-1",
      accessToken: token,
      password: "hunter2",
      note: `stored ${ciphertext}`,
    });
    assert.deepEqual(fields, {
      action: "disconnect-bank",
      householdId: "house-a",
      connectionId: "connection-1",
      note: "stored [redacted-token]",
    });
    assert.equal(JSON.stringify(fields).includes(token), false);
    assert.equal(JSON.stringify(fields).includes(ciphertext), false);
    assert.equal(redactSecrets(`token=${token}`).includes(token), false);
  });
});