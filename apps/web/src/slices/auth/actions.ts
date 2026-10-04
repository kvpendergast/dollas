"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth";
import { logError } from "@/lib/telemetry";

export type AuthFormState = { error: string };

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
    if (error instanceof Error && /verif/i.test(error.message)) {
      redirect("/verify-email");
    }
    logError(error, { action: "sign-in" });
    return { error: "Those credentials did not match a verified account." };
  }
  redirect("/");
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
