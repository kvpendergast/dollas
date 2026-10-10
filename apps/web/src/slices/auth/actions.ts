"use server";

import {
  FORGOT_PASSWORD_MESSAGE,
  inviteLinkPath,
  isInviteToken,
  hidesSetupDetail,
  MEMBER_MAIL_FAILURE,
  MEMBER_RESET_MAIL_FAILURE,
  memberFacingMessage,
  RateLimitedError,
  requestPasswordResetNotice,
  resendVerificationNotice,
  resetPasswordFailure,
  signInFailureFromCode,
  type RateLimitStore,
} from "@dollas/domain";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { isAgentAuthorizePath } from "@/lib/agent-oauth";
import { getAuth } from "@/lib/auth";
import { logError, logInfo } from "@/lib/telemetry";
import { clientAddress, readAuthError } from "@/slices/auth/auth-error";

export type AuthFormState = {
  error: string;
  notice?: string;
  unverifiedEmail?: string;
  retryAfterSeconds?: number;
};

const passwordResetLimits: RateLimitStore = new Map();
const verificationResendLimits: RateLimitStore = new Map();

const INTENT_COOKIE = "dollas_intent";

export type HouseholdIntent =
  | { mode: "start"; householdName: string }
  | { mode: "join"; inviteToken: string };

/** Only an invite page is allowed as a post-sign-in destination. Anything else goes home. */
function inviteReturnPath(raw: FormDataEntryValue | null): string | null {
  const token = String(raw ?? "");
  return isInviteToken(token) ? inviteLinkPath(token) : null;
}

async function rememberInvite(token: string) {
  const intent: HouseholdIntent = { mode: "join", inviteToken: token };
  (await cookies()).set(INTENT_COOKIE, JSON.stringify(intent), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

function messageFrom(error: unknown): string {
  return memberFacingMessage(error, MEMBER_MAIL_FAILURE);
}

export async function signInAction(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const invitePath = inviteReturnPath(formData.get("invite"));
  if (invitePath) await rememberInvite(String(formData.get("invite")));
  const agentRaw = String(formData.get("agentReturn") ?? "");
  const returnPath = isAgentAuthorizePath(agentRaw) ? agentRaw : (invitePath ?? "/");
  try {
    await getAuth().api.signInEmail({
      body: { email, password, callbackURL: returnPath },
      headers: await headers(),
    });
  } catch (error) {
    const parts = readAuthError(error);
    if (hidesSetupDetail(error)) {
      logError(error, { action: "sign-in" });
      return { error: messageFrom(error) };
    }
    const failure = signInFailureFromCode(parts.code, parts.message);
    if (failure.kind === "unverified") {
      logInfo("Sign-in blocked until the email is verified", { action: "sign-in" });
      return { error: failure.message, unverifiedEmail: email };
    }
    logError(error, { action: "sign-in" });
    return { error: failure.message };
  }
  redirect(returnPath);
}

export async function requestPasswordResetAction(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "");
  const headerList = await headers();
  const result = await requestPasswordResetNotice({
    email,
    ip: clientAddress(headerList),
    store: passwordResetLimits,
    nowMs: Date.now(),
    onRequestFailure: (error) => {
      logError(error, { action: "forgot-password" });
    },
    requestReset: async (normalized) => {
      await getAuth().api.requestPasswordReset({
        body: { email: normalized, redirectTo: "/reset-password" },
        headers: headerList,
      });
    },
  });
  if (result.isErr()) {
    if (hidesSetupDetail(result.error)) {
      logError(result.error, { action: "forgot-password" });
      return { error: "", notice: FORGOT_PASSWORD_MESSAGE };
    }
    return { error: memberFacingMessage(result.error, FORGOT_PASSWORD_MESSAGE) };
  }
  return { error: "", notice: result.value.message };
}

export async function resendVerificationAction(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "");
  const headerList = await headers();
  const result = await resendVerificationNotice({
    email,
    ip: clientAddress(headerList),
    store: verificationResendLimits,
    nowMs: Date.now(),
    onSendFailure: (error) => {
      logError(error, { action: "resend-verification" });
    },
    send: async (normalized) => {
      await getAuth().api.sendVerificationEmail({
        body: { email: normalized, callbackURL: "/welcome" },
        headers: headerList,
      });
    },
  });
  if (result.isErr()) {
    const retryAfterSeconds = result.error instanceof RateLimitedError ? result.error.retryAfterSeconds : undefined;
    return { error: memberFacingMessage(result.error, MEMBER_MAIL_FAILURE), retryAfterSeconds };
  }
  return { error: "", notice: result.value.message, retryAfterSeconds: result.value.retryAfterSeconds };
}

export async function resetPasswordAction(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (token.length < 8) return { error: resetPasswordFailure("INVALID_TOKEN") };
  if (password.length < 8) return { error: resetPasswordFailure("PASSWORD_TOO_SHORT") };
  if (password.length > 128) return { error: resetPasswordFailure("PASSWORD_TOO_LONG") };
  if (password !== confirm) return { error: "Those two passwords do not match." };
  try {
    await getAuth().api.resetPassword({
      body: { newPassword: password, token },
      headers: await headers(),
    });
  } catch (error) {
    logError(error, { action: "reset-password" });
    if (hidesSetupDetail(error)) return { error: memberFacingMessage(error, MEMBER_RESET_MAIL_FAILURE) };
    return { error: resetPasswordFailure(readAuthError(error).code) };
  }
  redirect("/sign-in?reset=1");
}

export async function signUpAction(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const householdName = String(formData.get("householdName") ?? "").trim();
  const inviteToken = String(formData.get("invite") ?? "");
  const invitePath = inviteReturnPath(inviteToken);
  if (name.length < 2) return { error: "Enter the name you use at home." };
  if (!invitePath && householdName.length < 2) return { error: "Name the household you are starting." };
  try {
    await getAuth().api.signUpEmail({
      // The verification link signs them in and returns to the invite page.
      body: { name, email, password, callbackURL: invitePath ?? "/welcome" },
      headers: await headers(),
    });
  } catch (error) {
    logError(error, { action: "sign-up" });
    return { error: messageFrom(error) };
  }
  if (invitePath) {
    await rememberInvite(inviteToken);
  } else {
    const intent: HouseholdIntent = { mode: "start", householdName };
    (await cookies()).set(INTENT_COOKIE, JSON.stringify(intent), {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
  }
  redirect("/verify-email");
}

export async function signOutAction() {
  await getAuth().api.signOut({ headers: await headers() });
  redirect("/sign-in");
}

export async function readHouseholdIntent(): Promise<HouseholdIntent | null> {
  const raw = (await cookies()).get(INTENT_COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as HouseholdIntent;
    if (parsed.mode === "join" && typeof parsed.inviteToken === "string" && isInviteToken(parsed.inviteToken)) return parsed;
    if (parsed.mode === "start" && typeof parsed.householdName === "string") return parsed;
  } catch (error) {
    logError(error, { action: "read-intent" });
  }
  return null;
}

export async function clearHouseholdIntent() {
  (await cookies()).delete(INTENT_COOKIE);
}
