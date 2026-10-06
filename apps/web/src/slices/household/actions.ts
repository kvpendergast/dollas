"use server";

import { memberFacingMessage } from "@dollas/domain";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { withActor } from "@/db/actor";
import { logError } from "@/lib/telemetry";
import { clearHouseholdIntent, type AuthFormState } from "@/slices/auth/actions";
import { requireVerifiedUser } from "@/slices/access/guard";

function idFrom(rows: unknown): string | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const row = rows[0] as { id?: unknown; code?: unknown };
  if (typeof row.id === "string") return row.id;
  return null;
}

export async function startHouseholdAction(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const ctx = await requireVerifiedUser();
  const name = String(formData.get("householdName") ?? "").trim();
  if (name.length < 2) return { error: "Name the household you are starting." };
  try {
    const rows = await withActor(ctx.actor.userId, (tx) => tx.execute(sql`select create_household(${name}) as id`));
    if (!idFrom(rows)) return { error: "The household was not created." };
  } catch (error) {
    logError(error, { action: "create-household", userId: ctx.actor.userId });
    return { error: memberFacingMessage(error, "Could not start that household.") };
  }
  await clearHouseholdIntent();
  revalidatePath("/");
  redirect("/");
}

export async function joinHouseholdAction(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const ctx = await requireVerifiedUser();
  const code = String(formData.get("inviteCode") ?? "").trim();
  if (code.length < 4) return { error: "Enter an invite code." };
  try {
    const rows = await withActor(ctx.actor.userId, (tx) => tx.execute(sql`select accept_invite(${code}) as id`));
    if (!idFrom(rows)) return { error: "That invite code is not active." };
  } catch (error) {
    logError(error, { action: "accept-invite", userId: ctx.actor.userId });
    return { error: memberFacingMessage(error, "Could not join with that invite.") };
  }
  await clearHouseholdIntent();
  revalidatePath("/");
  redirect("/");
}

export async function createInviteAction(): Promise<{ code?: string; error?: string }> {
  const ctx = await requireVerifiedUser();
  try {
    const rows = await withActor(ctx.actor.userId, (tx) => tx.execute(sql`select create_invite() as code`));
    const row = Array.isArray(rows) ? (rows[0] as { code?: string } | undefined) : undefined;
    if (!row?.code) return { error: "Could not create an invite." };
    revalidatePath("/household");
    return { code: row.code };
  } catch (error) {
    logError(error, { action: "create-invite", userId: ctx.session.user.id });
    return { error: "Could not create an invite." };
  }
}
