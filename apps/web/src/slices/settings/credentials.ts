import {
  hidesSetupDetail,
  isAuthEmail,
  MEMBER_MAIL_FAILURE,
  MembershipError,
  memberFacingMessage,
  normalizeAuthEmail,
} from "@dollas/domain";
import { headers } from "next/headers";
import { getAuth } from "@/lib/auth";
import { runMailAttempt } from "@/lib/mail-attempt";
import { logInfo, logError } from "@/lib/telemetry";
import { readAuthError } from "@/slices/auth/auth-error";
import { EMAIL_CHANGE_NOTICE, GOOGLE_PASSWORD_MESSAGE, NO_PASSWORD_MESSAGE } from "@/slices/settings/copy";
import { describeMembership, type MembershipActor, type MembershipResult } from "@/slices/settings/membership";

/**
 * UI-only. Email and password changes go through Better Auth.
 * MCP must not call this. A password, a new password, and an email change
 * are not MCP inputs or outputs.
 */
export const UI_ONLY_CREDENTIALS = ["changeMemberEmail", "changeMemberPassword"] as const;

const SIGN_IN_AGAIN = "Sign in again, then try that change.";

function fail(error: unknown, memberMessage: string): MembershipResult<never> {
  return { ok: false, error, memberMessage };
}

function fromAuthError(error: unknown, fallback: string): MembershipResult<never> {
  const parts = readAuthError(error);
  const code = parts.code ?? "";
  const message = parts.message ?? "";
  if (code === "INVALID_PASSWORD") return fail(error, "That current password does not match.");
  if (code === "CREDENTIAL_ACCOUNT_NOT_FOUND") return fail(error, GOOGLE_PASSWORD_MESSAGE);
  if (code === "PASSWORD_TOO_SHORT") return fail(error, "Use at least 8 characters.");
  if (code === "PASSWORD_TOO_LONG") return fail(error, "That password is too long.");
  if (code === "SESSION_EXPIRED" || /session expired/i.test(message)) return fail(error, SIGN_IN_AGAIN);
  if (message === "Email is the same") return fail(error, "That is already your email.");
  logError(error, { action: "credential-change" });
  if (hidesSetupDetail(error)) return fail(error, memberFacingMessage(error, fallback));
  return fail(error, fallback);
}

/**
 * UI-only. Asks Better Auth to confirm a new email. The current email stays
 * active until that link is opened. MCP must not call this.
 */
export async function changeMemberEmail(
  actor: MembershipActor,
  rawEmail: string,
): Promise<MembershipResult<{ notice: string }>> {
  const next = normalizeAuthEmail(rawEmail);
  if (!isAuthEmail(next)) {
    return fail(new MembershipError("Enter the email you use for the books."), "Enter the email you use for the books.");
  }
  const described = await describeMembership(actor);
  if (!described.ok) return described;
  if (normalizeAuthEmail(described.value.email) === next) {
    return fail(new MembershipError("That is already your email."), "That is already your email.");
  }
  const headerList = await headers();
  const attempt = await runMailAttempt(() =>
    getAuth().api.changeEmail({
      body: { newEmail: next, callbackURL: "/settings" },
      headers: headerList,
    }),
  );
  if (attempt.mailError) {
    logError(attempt.mailError, { action: "change-email", userId: actor.userId });
    return fail(attempt.mailError, memberFacingMessage(attempt.mailError, MEMBER_MAIL_FAILURE));
  }
  if (attempt.error) return fromAuthError(attempt.error, "Could not change that email.");
  logInfo("settings.email.change-requested", { action: "change-email", userId: actor.userId });
  return { ok: true, value: { notice: EMAIL_CHANGE_NOTICE } };
}

/**
 * UI-only. Changes a credential password. Requires the current password.
 * Google-only logins are told they sign in with Google. MCP must not call this.
 */
export async function changeMemberPassword(
  actor: MembershipActor,
  input: { currentPassword: string; newPassword: string; confirm: string },
): Promise<MembershipResult<{ notice: string }>> {
  const described = await describeMembership(actor);
  if (!described.ok) return described;
  if (described.value.signIn === "google") {
    return fail(new MembershipError(GOOGLE_PASSWORD_MESSAGE), GOOGLE_PASSWORD_MESSAGE);
  }
  if (described.value.signIn !== "password" && described.value.signIn !== "both") {
    return fail(new MembershipError(NO_PASSWORD_MESSAGE), NO_PASSWORD_MESSAGE);
  }
  if (input.newPassword.length < 8) return fail(new MembershipError("Use at least 8 characters."), "Use at least 8 characters.");
  if (input.newPassword.length > 128) return fail(new MembershipError("That password is too long."), "That password is too long.");
  if (input.newPassword !== input.confirm) {
    return fail(new MembershipError("Those two passwords do not match."), "Those two passwords do not match.");
  }
  if (input.currentPassword.length === 0) {
    return fail(new MembershipError("Enter your current password."), "Enter your current password.");
  }
  try {
    await getAuth().api.changePassword({
      body: {
        currentPassword: input.currentPassword,
        newPassword: input.newPassword,
        revokeOtherSessions: true,
      },
      headers: await headers(),
    });
  } catch (error) {
    return fromAuthError(error, "Could not change that password.");
  }
  logInfo("settings.password.changed", { action: "change-password", userId: actor.userId });
  return { ok: true, value: { notice: "Password changed." } };
}
