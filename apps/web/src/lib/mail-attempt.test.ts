import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MailDeliveryError } from "@dollas/domain";
import { recordMailFailure, runMailAttempt } from "./mail-attempt";

describe("mail attempt", () => {
  it("keeps a mail failure when the caller swallows the throw", async () => {
    const result = await runMailAttempt(async () => {
      try {
        recordMailFailure(new MailDeliveryError("Resend could not send the verification email."));
        throw new Error("Verification email failed");
      } catch {
        return "continued";
      }
    });
    assert.equal(result.value, "continued");
    assert.equal(result.error, undefined);
    assert.ok(result.mailError instanceof MailDeliveryError);
  });

  it("leaves mail untouched when nothing failed", async () => {
    const result = await runMailAttempt(async () => "sent");
    assert.equal(result.value, "sent");
    assert.equal(result.mailError, undefined);
  });
});
