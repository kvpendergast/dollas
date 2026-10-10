import {
  DELETE_CONFIRMATION_MESSAGE,
  DomainError,
  hidesSetupDetail,
  LAST_OWNER_MESSAGE,
  MembershipError,
  NOT_A_MEMBER_MESSAGE,
  memberFacingMessage,
  planDeleteHousehold,
  planLeaveHousehold,
  planProfileName,
  planTransferOwnership,
  signInMethod,
  type AuthProvider,
  type HouseholdRole,
  type HouseholdSeat,
  type SignInMethod,
} from "@dollas/domain";
import { eq, sql } from "drizzle-orm";
import { withActor } from "@/db/actor";
import type { AppDatabase } from "@/db/client";
import { getDb } from "@/db/client";
import { account, household, householdMember, user } from "@/db/schema";
import { logError, logInfo } from "@/lib/telemetry";

/**
 * Membership services. A page action and an MCP tool both call these.
 * They do not accept a password, a new password, or an email change.
 * Those stay in credentials.ts and are UI-only.
 *
 * Household statements run inside withActor, which assumes dollas_app.
 * Leaving, handing off, and deleting go through security-definer functions
 * because that role cannot delete membership or household rows itself.
 */
export type MembershipActor = {
  userId: string;
  householdId: string;
};

export type MembershipMember = {
  userId: string;
  name: string;
  role: HouseholdRole;
};

export type MembershipSnapshot = {
  name: string;
  email: string;
  householdName: string;
  role: HouseholdRole;
  lastOwner: boolean;
  signIn: SignInMethod;
  members: MembershipMember[];
};

export type MembershipResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown; memberMessage: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SAFE_SQL_MESSAGES = [
  LAST_OWNER_MESSAGE,
  DELETE_CONFIRMATION_MESSAGE,
  NOT_A_MEMBER_MESSAGE,
  "Only an owner can hand off the household.",
  "Only an owner can delete the household.",
  "Choose another member.",
  "That person is not in this household.",
  "That person is already an owner.",
  "Verify your email before changing household membership",
];

function asProviders(values: string[]): AuthProvider[] {
  return values.filter((value): value is AuthProvider => value === "credential" || value === "google");
}

function seatsFrom(members: readonly MembershipMember[]): HouseholdSeat[] {
  return members.map((member) => ({ userId: member.userId, role: member.role }));
}

function textOf(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const cause = "cause" in error && error.cause instanceof Error ? error.cause.message : "";
  return `${error.message}\n${cause}`;
}

function fail(error: unknown, fallback: string): MembershipResult<never> {
  if (error instanceof DomainError || hidesSetupDetail(error)) {
    return { ok: false, error, memberMessage: memberFacingMessage(error, fallback) };
  }
  const text = textOf(error);
  const known = SAFE_SQL_MESSAGES.find((message) => text.includes(message));
  return { ok: false, error, memberMessage: known ?? fallback };
}

function householdIdOf(actor: MembershipActor): string | null {
  return UUID.test(actor.householdId) ? actor.householdId : null;
}

/** Reads this member's profile and the household they belong to. MCP tools call this too. */
export async function describeMembership(
  actor: MembershipActor,
  database: AppDatabase = getDb(),
): Promise<MembershipResult<MembershipSnapshot>> {
  const householdId = householdIdOf(actor);
  if (!householdId) return fail(new MembershipError(NOT_A_MEMBER_MESSAGE), "Could not open settings.");
  try {
    const loaded = await withActor(
      actor.userId,
      async (tx) => {
        const [person] = await tx
          .select({ name: user.name, email: user.email })
          .from(user)
          .where(eq(user.id, actor.userId));
        const providers = await tx
          .select({ providerId: account.providerId })
          .from(account)
          .where(eq(account.userId, actor.userId));
        const [house] = await tx
          .select({ name: household.name })
          .from(household)
          .where(eq(household.id, householdId));
        const members = await tx
          .select({ userId: householdMember.userId, role: householdMember.role, name: user.name })
          .from(householdMember)
          .innerJoin(user, eq(user.id, householdMember.userId))
          .where(eq(householdMember.householdId, householdId));
        return { person, providers, house, members };
      },
      database,
    );
    if (!loaded.person || !loaded.house) return fail(new MembershipError(NOT_A_MEMBER_MESSAGE), "Could not open settings.");
    const members: MembershipMember[] = loaded.members
      .map((member) => ({
        userId: member.userId,
        name: member.name,
        role: member.role === "owner" ? ("owner" as const) : ("member" as const),
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
    const mine = members.find((member) => member.userId === actor.userId);
    if (!mine) return fail(new MembershipError(NOT_A_MEMBER_MESSAGE), "Could not open settings.");
    const owners = members.filter((member) => member.role === "owner").length;
    return {
      ok: true,
      value: {
        name: loaded.person.name,
        email: loaded.person.email,
        householdName: loaded.house.name,
        role: mine.role,
        lastOwner: mine.role === "owner" && owners <= 1,
        signIn: signInMethod(asProviders(loaded.providers.map((row) => row.providerId))),
        members,
      },
    };
  } catch (error) {
    logError(error, { action: "describe-membership", userId: actor.userId, householdId });
    return fail(error, "Could not open settings.");
  }
}

/** Changes the signed-in member's name. MCP tools call this too. */
export async function updateProfileName(
  actor: MembershipActor,
  rawName: string,
  database: AppDatabase = getDb(),
): Promise<MembershipResult<{ name: string }>> {
  const planned = planProfileName(rawName);
  if (planned.isErr()) return fail(planned.error, "Could not save that name.");
  const described = await describeMembership(actor, database);
  if (!described.ok) return described;
  try {
    const updated = await withActor(
      actor.userId,
      (tx) =>
        tx
          .update(user)
          .set({ name: planned.value, updatedAt: new Date() })
          .where(eq(user.id, actor.userId))
          .returning({ name: user.name }),
      database,
    );
    const name = updated[0]?.name;
    if (name !== planned.value) return fail(new MembershipError("Could not save that name."), "Could not save that name.");
    logInfo("settings.name.updated", {
      action: "update-profile-name",
      userId: actor.userId,
      householdId: actor.householdId,
    });
    return { ok: true, value: { name } };
  } catch (error) {
    logError(error, { action: "update-profile-name", userId: actor.userId, householdId: actor.householdId });
    return fail(error, "Could not save that name.");
  }
}

/** Leaves the household. The last owner is refused. MCP tools call this too. */
export async function leaveHousehold(
  actor: MembershipActor,
  database: AppDatabase = getDb(),
): Promise<MembershipResult<{ userId: string }>> {
  const described = await describeMembership(actor, database);
  if (!described.ok) return described;
  const planned = planLeaveHousehold({ actorUserId: actor.userId, seats: seatsFrom(described.value.members) });
  if (planned.isErr()) {
    logInfo(planned.error.message, { action: "leave-household", userId: actor.userId, householdId: actor.householdId });
    return fail(planned.error, "Could not leave the household.");
  }
  try {
    await withActor(
      actor.userId,
      (tx) => tx.execute(sql`select leave_household(${actor.householdId})`),
      database,
    );
  } catch (error) {
    logError(error, { action: "leave-household", userId: actor.userId, householdId: actor.householdId });
    return fail(error, "Could not leave the household.");
  }
  logInfo("settings.household.left", { action: "leave-household", userId: actor.userId, householdId: actor.householdId });
  return { ok: true, value: { userId: actor.userId } };
}

/** Makes another member the owner and the caller a member. MCP tools call this too. */
export async function transferOwnership(
  actor: MembershipActor,
  targetUserId: string,
  database: AppDatabase = getDb(),
): Promise<MembershipResult<{ fromUserId: string; toUserId: string }>> {
  const described = await describeMembership(actor, database);
  if (!described.ok) return described;
  const planned = planTransferOwnership({
    actorUserId: actor.userId,
    targetUserId,
    seats: seatsFrom(described.value.members),
  });
  if (planned.isErr()) {
    logInfo(planned.error.message, {
      action: "transfer-ownership",
      userId: actor.userId,
      householdId: actor.householdId,
    });
    return fail(planned.error, "Could not hand off the household.");
  }
  try {
    await withActor(
      actor.userId,
      (tx) => tx.execute(sql`select transfer_household_ownership(${actor.householdId}, ${planned.value.toUserId})`),
      database,
    );
  } catch (error) {
    logError(error, { action: "transfer-ownership", userId: actor.userId, householdId: actor.householdId });
    return fail(error, "Could not hand off the household.");
  }
  logInfo("settings.ownership.transferred", {
    action: "transfer-ownership",
    userId: actor.userId,
    householdId: actor.householdId,
  });
  return { ok: true, value: planned.value };
}

/**
 * Deletes one household after the owner types its name.
 * Rows in every other household stay. MCP tools call this too.
 */
export async function deleteHousehold(
  actor: MembershipActor,
  confirmation: string,
  database: AppDatabase = getDb(),
): Promise<MembershipResult<{ householdId: string }>> {
  const described = await describeMembership(actor, database);
  if (!described.ok) return described;
  const planned = planDeleteHousehold({
    actorUserId: actor.userId,
    householdId: actor.householdId,
    householdName: described.value.householdName,
    confirmation,
    seats: seatsFrom(described.value.members),
    rows: [],
  });
  if (planned.isErr()) {
    logInfo("settings.household.delete-refused", {
      action: "delete-household",
      userId: actor.userId,
      householdId: actor.householdId,
    });
    return fail(planned.error, "Could not delete the household.");
  }
  try {
    await withActor(
      actor.userId,
      (tx) => tx.execute(sql`select delete_household(${actor.householdId}, ${confirmation})`),
      database,
    );
  } catch (error) {
    logError(error, { action: "delete-household", userId: actor.userId, householdId: actor.householdId });
    return fail(error, "Could not delete the household.");
  }
  logInfo("settings.household.deleted", {
    action: "delete-household",
    userId: actor.userId,
    householdId: actor.householdId,
  });
  return { ok: true, value: { householdId: planned.value.householdId } };
}
