"use server";

import {
  RateLimitedError,
  requestPasswordResetNotice,
  resendVerificationNotice,
  resetPasswordFailure,
  signInFailureFromCode,
  type RateLimitStore,
} from "@dollas/domain";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
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
  | { mode: "join"; inviteCode: string };

function messageFrom(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return "Something went wrong. Try again.";
}

export async function signInAction(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  try {
    await getAuth().api.signInEmail({
      body: { email, password, callbackURL: "/" },
      headers: await headers(),
    });
  } catch (error) {
    const parts = readAuthError(error);
    const failure = signInFailureFromCode(parts.code, parts.message);
    if (failure.kind === "unverified") {
      logInfo("Sign-in blocked until the email is verified", { action: "sign-in" });
      return { error: failure.message, unverifiedEmail: email };
    }
    logError(error, { action: "sign-in" });
    return { error: failure.message };
  }
  redirect("/");
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
  if (result.isErr()) return { error: result.error.message };
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
    return { error: result.error.message, retryAfterSeconds };
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
    return { error: resetPasswordFailure(readAuthError(error).code) };
  }
  redirect("/sign-in?reset=1");
}

export async function signUpAction(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const mode = String(formData.get("mode") ?? "start");
  const householdName = String(formData.get("householdName") ?? "").trim();
  const inviteCode = String(formData.get("inviteCode") ?? "").trim();
  if (name.length < 2) return { error: "Enter the name you use at home." };
  if (mode === "start" && householdName.length < 2) return { error: "Name the household you are starting." };
  if (mode === "join" && inviteCode.length < 4) return { error: "Enter an invite code." };
  try {
    await getAuth().api.signUpEmail({
      body: { name, email, password, callbackURL: "/welcome" },
      headers: await headers(),
    });
  } catch (error) {
    logError(error, { action: "sign-up" });
    return { error: messageFrom(error) };
  }
  const intent: HouseholdIntent = mode === "join" ? { mode: "join", inviteCode } : { mode: "start", householdName };
  const jar = await cookies();
  jar.set(INTENT_COOKIE, JSON.stringify(intent), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
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
    if (parsed.mode === "join" && typeof parsed.inviteCode === "string") return parsed;
    if (parsed.mode === "start" && typeof parsed.householdName === "string") return parsed;
  } catch (error) {
    logError(error, { action: "read-intent" });
  }
  return null;
}

export async function clearHouseholdIntent() {
  (await cookies()).delete(INTENT_COOKIE);
}
