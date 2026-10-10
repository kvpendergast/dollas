import { MEMBER_MAIL_FAILURE, memberFacingMessage } from "@dollas/domain";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deliverEmailChangeEmail } from "./verification-email";

const email = "ada@maple.local";
const url = "http://localhost:3000/api/auth/verify-email?token=change-token&callbackURL=/settings";
const env = {
  RESEND_API_KEY: "test-resend-key",
  RESEND_FROM: "Dollas <verify@dollas.test>",
};

describe("email change mail", () => {
  it("sends the new address a link and says the previous email stays active", async () => {
    let text = "";
    let to = "";
    const result = await deliverEmailChangeEmail(
      { email, url },
      {
        env,
        send: async (message) => {
          text = message.text;
          to = message.to;
          assert.equal(message.subject, "Confirm your new email for Dollas");
        },
      },
    );
    assert.equal(result.isOk(), true);
    assert.equal(to, email);
    assert.match(text, /previous email stays the one you sign in with/);
    assert.equal(text.includes(url), true);
    assert.equal(/RESEND_|GOOGLE_|DATABASE_/.test(text), false);
  });

  it("hides a delivery failure from the member", async () => {
    const result = await deliverEmailChangeEmail(
      { email, url },
      {
        env: { ...env, VERCEL: "1" },
        send: async () => {
          throw new Error("provider down");
        },
      },
    );
    assert.equal(result.isErr(), true);
    if (result.isErr()) {
      const shown = memberFacingMessage(result.error, MEMBER_MAIL_FAILURE);
      assert.equal(shown, MEMBER_MAIL_FAILURE);
      assert.equal(shown.includes("RESEND_"), false);
      assert.equal(shown.includes(url), false);
    }
  });
});
