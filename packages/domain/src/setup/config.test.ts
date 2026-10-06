import { describe, expect, it } from "vitest";
import { ConfigError, InvalidSetupTokenError, MailDeliveryError, TokenEncryptionError } from "../errors";
import {
  MEMBER_MAIL_FAILURE,
  MEMBER_RESET_MAIL_FAILURE,
  MEMBER_SETUP_FAILURE,
  memberFacingMessage,
  planVerificationMail,
  resolveGoogleSignIn,
  verificationHelpForMember,
} from "./config";

const secretKey = "re_live_secret_value";
const clientSecret = "google-client-secret-value";

const leak = /GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|RESEND_API_KEY|RESEND_FROM|BETTER_AUTH_|BANK_CONNECTION_KEYS|DATABASE_URL|\bResend\b|not configured|server log|Vercel/i;

describe("member-facing setup copy", () => {
  it("maps mail config errors to a next step without env var names", () => {
    const missing = planVerificationMail({ apiKey: "", from: "  ", hosted: true });
    const partial = planVerificationMail({ apiKey: `  ${secretKey}  `, from: "", hosted: false });
    expect(missing.isErr()).toBe(true);
    expect(partial.isErr()).toBe(true);
    if (missing.isErr() && partial.isErr()) {
      expect(missing.error).toBeInstanceOf(Error);
      expect(missing.error).toBeInstanceOf(ConfigError);
      expect(missing.error.message).toMatch(/RESEND_API_KEY/);
      expect(missing.error.message).toMatch(/RESEND_FROM/);
      expect(partial.error.message).toMatch(/RESEND_FROM/);
      expect(partial.error.message).not.toContain(secretKey);
      for (const error of [missing.error, partial.error]) {
        const shown = memberFacingMessage(error, MEMBER_MAIL_FAILURE);
        expect(shown).toBe(MEMBER_MAIL_FAILURE);
        expect(shown).not.toMatch(leak);
        expect(shown).toMatch(/help/);
        expect(shown).toMatch(/sign in|Try again/);
      }
    }
  });

  it("keeps provider setup details out of every verification sentence a member can see", () => {
    for (const state of ["send", "local", "unavailable"] as const) {
      expect(verificationHelpForMember(state)).not.toMatch(leak);
    }
    expect(verificationHelpForMember("send")).toMatch(/inbox/);
    expect(verificationHelpForMember("unavailable")).toBe(MEMBER_MAIL_FAILURE);
    expect(verificationHelpForMember("local")).toBe(MEMBER_MAIL_FAILURE);
    const delivery = new MailDeliveryError(
      "Resend could not send the verification email: The dollas domain is not verified.",
    );
    expect(memberFacingMessage(delivery, MEMBER_MAIL_FAILURE)).toBe(MEMBER_MAIL_FAILURE);
    expect(memberFacingMessage(new Error("RESEND_API_KEY is required"), MEMBER_MAIL_FAILURE)).toBe(MEMBER_MAIL_FAILURE);
    const reset = new MailDeliveryError("Resend could not send the password reset email.");
    expect(memberFacingMessage(reset, MEMBER_RESET_MAIL_FAILURE)).toBe(MEMBER_RESET_MAIL_FAILURE);
    expect(MEMBER_RESET_MAIL_FAILURE).not.toMatch(leak);
    expect(MEMBER_RESET_MAIL_FAILURE).toMatch(/reset link/);
    const resetPlan = planVerificationMail({
      apiKey: "",
      from: "",
      hosted: true,
      label: "password reset email",
    });
    expect(resetPlan.isErr()).toBe(true);
    if (resetPlan.isErr()) {
      expect(resetPlan.error.message).toMatch(/password reset email/);
      expect(memberFacingMessage(resetPlan.error, MEMBER_RESET_MAIL_FAILURE)).toBe(MEMBER_RESET_MAIL_FAILURE);
    }
  });

  it("hides Google sign-in when it is not configured and does not show that as a member error", () => {
    const absent = resolveGoogleSignIn({ clientId: "", clientSecret: "  " });
    expect(absent.isOk()).toBe(true);
    if (absent.isOk()) expect(absent.value.enabled).toBe(false);

    const ready = resolveGoogleSignIn({ clientId: " client ", clientSecret: " secret " });
    expect(ready.isOk()).toBe(true);
    if (ready.isOk()) expect(ready.value.enabled).toBe(true);

    const half = resolveGoogleSignIn({ clientId: "", clientSecret });
    expect(half.isErr()).toBe(true);
    if (half.isErr()) {
      expect(half.error).toBeInstanceOf(ConfigError);
      expect(half.error.message).toMatch(/GOOGLE_CLIENT_ID/);
      expect(half.error.message).not.toContain(clientSecret);
      const shown = memberFacingMessage(half.error);
      expect(shown).not.toMatch(leak);
      expect(shown).not.toMatch(/GOOGLE_CLIENT/);
    }
  });

  it("keeps bank key and access-url detail in the log error, not the member sentence", () => {
    const missing = new TokenEncryptionError(
      "BANK_CONNECTION_KEYS is required. Set comma-separated version:base64 entries of 32-byte keys.",
    );
    const undecryptable = new TokenEncryptionError("The current connection encryption key is missing.");
    const accessUrl = new Error("GET https://demo-user:demo-pass@bridge.example/simplefin/accounts failed");
    for (const error of [missing, undecryptable, accessUrl]) {
      const shown = memberFacingMessage(error, MEMBER_SETUP_FAILURE);
      expect(shown).toBe(MEMBER_SETUP_FAILURE);
      expect(shown).not.toMatch(leak);
      expect(shown).not.toContain("demo-pass");
    }
    const token = new InvalidSetupTokenError();
    expect(memberFacingMessage(token, MEMBER_SETUP_FAILURE)).toBe(token.message);
    expect(token.message).toMatch(/Paste a new one/);
  });
});
