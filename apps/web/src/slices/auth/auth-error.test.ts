import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GENERIC_SIGN_IN_MESSAGE, UNVERIFIED_SIGN_IN_MESSAGE, signInFailureFromCode } from "@dollas/domain";
import { APIError } from "better-auth/api";
import { clientAddress, readAuthError } from "./auth-error";

describe("sign-in errors", () => {
  it("shows a verification prompt for an unverified email and a generic message otherwise", () => {
    const unverified = APIError.from("FORBIDDEN", { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" });
    const wrong = APIError.from("UNAUTHORIZED", {
      code: "INVALID_EMAIL_OR_PASSWORD",
      message: "Invalid email or password",
    });
    const unverifiedParts = readAuthError(unverified);
    const wrongParts = readAuthError(wrong);
    const unverifiedFailure = signInFailureFromCode(unverifiedParts.code, unverifiedParts.message);
    const wrongFailure = signInFailureFromCode(wrongParts.code, wrongParts.message);
    assert.equal(unverifiedFailure.kind, "unverified");
    assert.equal(unverifiedFailure.message, UNVERIFIED_SIGN_IN_MESSAGE);
    assert.equal(wrongFailure.kind, "generic");
    assert.equal(wrongFailure.message, GENERIC_SIGN_IN_MESSAGE);
    assert.equal(/verif/i.test(wrongFailure.message), false);
    assert.notEqual(unverifiedFailure.message, wrongFailure.message);
  });
});

describe("client address", () => {
  it("uses the first forwarded address and ignores the rest", () => {
    const headers = new Headers({ "x-forwarded-for": "203.0.113.8, 10.0.0.1" });
    assert.equal(clientAddress(headers), "203.0.113.8");
    assert.equal(clientAddress(new Headers()), "unknown");
  });
});
