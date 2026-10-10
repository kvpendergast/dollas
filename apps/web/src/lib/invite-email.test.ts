import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initTelemetry } from "./telemetry";
import { deliverHouseholdInviteEmail, inviteMailMode, type VerificationMessage } from "./verification-email";

const input = {
  email: "sam@maple.local",
  url: "https://dollas.test/invite/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde",
  householdName: "Maple House",
  inviterName: "Ada",
  expiresOn: "2026-10-17",
};

describe("household invite email", () => {
  it("sends the link from RESEND_FROM through Resend when it is set up", async () => {
    initTelemetry();
    const sent: Array<{ message: VerificationMessage; apiKey: string }> = [];
    const env = { RESEND_API_KEY: "test-resend-key", RESEND_FROM: "noreply@dollas.kylependergast.com", VERCEL: "1" };
    assert.equal(inviteMailMode(env), "send");
    const result = await deliverHouseholdInviteEmail(input, {
      env,
      send: async (message, apiKey) => {
        sent.push({ message, apiKey });
      },
    });
    assert.equal(result.isOk(), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].message.from, "noreply@dollas.kylependergast.com");
    assert.equal(sent[0].message.to, input.email);
    assert.match(sent[0].message.subject, /Ada invited you to the Maple House books/);
    assert.ok(sent[0].message.text.includes(input.url));
    assert.match(sent[0].message.text, /expires on 2026-10-17/);
  });

  it("reports local and unavailable modes so the owner can copy the link instead", async () => {
    assert.equal(inviteMailMode({}), "local");
    assert.equal(inviteMailMode({ VERCEL: "1" }), "unavailable");
    const hosted = await deliverHouseholdInviteEmail(input, {
      env: { VERCEL: "1" },
      send: async () => {
        throw new Error("should not send");
      },
    });
    assert.equal(hosted.isErr(), true);
  });

  it("keeps the link out of a provider failure message", async () => {
    const result = await deliverHouseholdInviteEmail(input, {
      env: { RESEND_API_KEY: "test-resend-key", RESEND_FROM: "noreply@dollas.test" },
      send: async () => {
        throw new Error(`rejected ${input.url}`);
      },
    });
    assert.equal(result.isErr(), true);
    if (result.isErr()) assert.equal(result.error.message.includes(input.url), false);
  });
});
