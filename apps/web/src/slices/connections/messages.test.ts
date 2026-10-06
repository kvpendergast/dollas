import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ConfigError,
  InvalidSetupTokenError,
  parseTokenKeyRing,
  ProviderAuthError,
  TokenEncryptionError,
} from "@dollas/domain";
import { BANK_SETUP_UNAVAILABLE, memberBankMessage } from "./messages";

describe("member bank messages", () => {
  it("hides encryption setup details", () => {
    const parsed = parseTokenKeyRing(undefined);
    assert.equal(parsed.isErr(), true);
    if (parsed.isOk()) return;
    const message = memberBankMessage(parsed.error, "Could not link that bank.");
    assert.equal(message, BANK_SETUP_UNAVAILABLE);
    assert.equal(message.includes("BANK_"), false);
    assert.equal(message.includes("env"), false);
    assert.match(message, /try again/i);
    const missingKey = memberBankMessage(
      new TokenEncryptionError("The current connection encryption key is missing."),
      "Could not sync that bank.",
    );
    assert.equal(missingKey, BANK_SETUP_UNAVAILABLE);
  });

  it("keeps a plain provider next step and drops config or raw provider detail", () => {
    const token = memberBankMessage(new InvalidSetupTokenError(), "Could not link that bank.");
    assert.match(token, /Paste a new one/);
    assert.equal(token.includes("BANK_"), false);

    const config = memberBankMessage(
      new ConfigError("BANK_CONNECTION_KEYS is required."),
      "Could not link that bank.",
    );
    assert.equal(config, BANK_SETUP_UNAVAILABLE);

    const leaked = memberBankMessage(
      new ProviderAuthError("The bank rejected https://demo-user:demo-pass@bridge.example/simplefin."),
      "Could not sync that bank.",
    );
    assert.equal(leaked, BANK_SETUP_UNAVAILABLE);
    assert.equal(leaked.includes("demo-pass"), false);

    const shown = memberBankMessage(new Error("token=super-secret http://user:pass@host"), "Could not sync that bank.");
    assert.equal(shown, "Could not sync that bank.");
    assert.equal(shown.includes("super-secret"), false);
  });
});
