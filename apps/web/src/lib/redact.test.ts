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

  it("drops password reset and verification links", () => {
    const reset = "http://localhost:3000/api/auth/reset-password/abcDEF1234567890token?callbackURL=%2Freset-password";
    const verify = "http://localhost:3000/api/auth/verify-email?token=header.payload.sig&callbackURL=%2Fwelcome";
    const scrubbed = redactSecrets(`mail ${reset} and ${verify}`);
    assert.equal(scrubbed.includes("abcDEF1234567890token"), false);
    assert.equal(scrubbed.includes("header.payload.sig"), false);
    assert.match(scrubbed, /\[redacted-link\]/);
    const fields = redactLogAttributes({ url: reset, note: "sent" });
    assert.equal(JSON.stringify(fields).includes("abcDEF"), false);
  });
});