"use server";

import { INVITE_MESSAGES, isInviteToken } from "@dollas/domain";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth";
import { logError } from "@/lib/telemetry";
import { clearHouseholdIntent, type AuthFormState } from "@/slices/auth/actions";
import { requireBooks, requireVerifiedUser } from "@/slices/access/guard";
import {
  acceptHouseholdInvite,
  copyHouseholdInviteLink,
  createHouseholdInvite,
  revokeHouseholdInvite,
  type InviteMailOutcome,
} from "./invites";
import { startHousehold } from "./start";

export async function startHouseholdAction(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const ctx = await requireVerifiedUser();
  const started = await startHousehold(ctx.actor.userId, String(formData.get("householdName") ?? ""));
  if (!started.ok) return { error: started.memberMessage };
  await clearHouseholdIntent();
  revalidatePath("/");
  redirect("/");
}

/** Pulls the token out of a pasted invite link, or takes a bare token. */
function tokenFromPaste(raw: string): string | null {
  const value = raw.trim();
  if (isInviteToken(value)) return value;
  const match = /\/invite\/([A-Za-z0-9_-]{43})(?:[/?#]|$)/.exec(value);
  return match ? match[1] : null;
}

/** The welcome screen's Join tab. Opens the invite page, which does the checks. */
export async function joinHouseholdAction(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  await requireVerifiedUser();
  const token = tokenFromPaste(String(formData.get("inviteLink") ?? ""));
  if (!token) return { error: "Paste the whole invite link from your email." };
  redirect(`/invite/${token}`);
}

export type InviteFormState = {
  error: string;
  notice?: string;
  link?: string;
  email?: string;
};

function mailNotice(mail: InviteMailOutcome, email: string): string {
  if (mail === "sent") return `Invite sent to ${email}. You can also copy the link and send it yourself.`;
  if (mail === "logged") return `Invite ready for ${email}. Email is not set up here, so copy the link and send it yourself.`;
  return `Invite ready for ${email}, but the email did not go out. Copy the link and send it yourself.`;
}

export async function createInviteAction(_state: InviteFormState, formData: FormData): Promise<InviteFormState> {
  const books = await requireBooks();
  const email = String(formData.get("email") ?? "");
  const created = await createHouseholdInvite({ userId: books.userId, householdId: books.householdId }, email);
  if (!created.ok) return { error: created.memberMessage };
  revalidatePath("/household");
  return {
    error: "",
    notice: mailNotice(created.value.mail, created.value.email),
    link: created.value.link,
    email: created.value.email,
  };
}

export async function copyInviteLinkAction(inviteId: string): Promise<{ link?: string; error?: string }> {
  const books = await requireBooks();
  const copied = await copyHouseholdInviteLink({ userId: books.userId, householdId: books.householdId }, inviteId);
  if (!copied.ok) return { error: copied.memberMessage };
  return { link: copied.value.link };
}

export async function revokeInviteAction(inviteId: string): Promise<{ error?: string }> {
  const books = await requireBooks();
  const revoked = await revokeHouseholdInvite({ userId: books.userId, householdId: books.householdId }, inviteId);
  revalidatePath("/household");
  if (!revoked.ok) return { error: revoked.memberMessage };
  return {};
}

/** UI-only. Joins after the member presses the button on the invite page. */
export async function acceptInviteAction(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const token = String(formData.get("token") ?? "");
  const ctx = await requireVerifiedUser();
  if (!isInviteToken(token)) return { error: INVITE_MESSAGES.not_found };
  const accepted = await acceptHouseholdInvite(ctx.actor.userId, token);
  if (!accepted.ok) return { error: accepted.memberMessage };
  await clearHouseholdIntent();
  revalidatePath("/");
  redirect("/");
}

/** Signs out a login that does not match the invite and returns to sign-in with the link kept. */
export async function signOutForInviteAction(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  try {
    await getAuth().api.signOut({ headers: await headers() });
  } catch (error) {
    logError(error, { action: "sign-out-for-invite" });
  }
  redirect(isInviteToken(token) ? `/sign-in?invite=${token}` : "/sign-in");
}
