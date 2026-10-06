import { err, ok, type Result } from "neverthrow";
import { LastOwnerError, MembershipError } from "../errors";
import type { AuthProvider, HouseholdRole } from "./access";

export const LAST_OWNER_MESSAGE =
  "You are the last owner. Hand ownership to another member, or delete the household, before you leave.";

export const NOT_A_MEMBER_MESSAGE = "You are not a member of this household.";

export const DELETE_CONFIRMATION_MESSAGE = "Type the household name exactly to delete it.";

const NAME_MIN = 2;
const NAME_MAX = 80;
const CONFIRMATION_MAX = 500;

export type HouseholdSeat = {
  userId: string;
  role: HouseholdRole;
};

export type ScopedHouseholdRow = {
  id: string;
  householdId: string;
};

export type SignInMethod = "password" | "google" | "both" | "none";

function seatOf(seats: readonly HouseholdSeat[], userId: string): HouseholdSeat | undefined {
  return seats.find((seat) => seat.userId === userId);
}

function ownerCount(seats: readonly HouseholdSeat[]): number {
  return seats.filter((seat) => seat.role === "owner").length;
}

/** How this login signs in. Credential is the password login. Google is not a password. */
export function signInMethod(providers: readonly AuthProvider[]): SignInMethod {
  const google = providers.includes("google");
  const password = providers.includes("credential");
  if (google && password) return "both";
  if (google) return "google";
  if (password) return "password";
  return "none";
}

/** The name stored on the member's login. Collapses extra space and rejects control characters. */
export function planProfileName(raw: string): Result<string, MembershipError> {
  if (/[\u0000-\u001f\u007f]/.test(raw)) return err(new MembershipError("Enter the name you use at home."));
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length < NAME_MIN) return err(new MembershipError("Enter the name you use at home."));
  if (name.length > NAME_MAX) return err(new MembershipError("That name is too long."));
  return ok(name);
}

/**
 * A member may leave. The last owner may not: someone else has to own the
 * books, or the household has to be deleted.
 */
export function planLeaveHousehold(input: {
  actorUserId: string;
  seats: readonly HouseholdSeat[];
}): Result<{ userId: string }, LastOwnerError | MembershipError> {
  const seat = seatOf(input.seats, input.actorUserId);
  if (!seat) return err(new MembershipError(NOT_A_MEMBER_MESSAGE));
  if (seat.role === "owner" && ownerCount(input.seats) <= 1) return err(new LastOwnerError(LAST_OWNER_MESSAGE));
  return ok({ userId: input.actorUserId });
}

/**
 * Hands this owner's role to another member of the same household.
 * The caller becomes a member. An existing owner is not a target.
 */
export function planTransferOwnership(input: {
  actorUserId: string;
  targetUserId: string;
  seats: readonly HouseholdSeat[];
}): Result<{ fromUserId: string; toUserId: string }, MembershipError> {
  const actor = seatOf(input.seats, input.actorUserId);
  if (!actor) return err(new MembershipError(NOT_A_MEMBER_MESSAGE));
  if (actor.role !== "owner") return err(new MembershipError("Only an owner can hand off the household."));
  if (input.targetUserId === input.actorUserId || input.targetUserId.trim().length === 0) {
    return err(new MembershipError("Choose another member."));
  }
  const target = seatOf(input.seats, input.targetUserId);
  if (!target) return err(new MembershipError("That person is not in this household."));
  if (target.role === "owner") return err(new MembershipError("That person is already an owner."));
  return ok({ fromUserId: input.actorUserId, toUserId: input.targetUserId });
}

/** Rows whose household id is the one being deleted. Every other household stays. */
export function householdRowsInScope<T extends { householdId: string }>(
  rows: readonly T[],
  householdId: string,
): T[] {
  return rows.filter((row) => row.householdId === householdId);
}

/**
 * An owner deletes one household after typing its name.
 * The returned ids are only rows in that household.
 */
export function planDeleteHousehold(input: {
  actorUserId: string;
  householdId: string;
  householdName: string;
  confirmation: string;
  seats: readonly HouseholdSeat[];
  rows: readonly ScopedHouseholdRow[];
}): Result<{ householdId: string; removedIds: readonly string[] }, MembershipError> {
  const actor = seatOf(input.seats, input.actorUserId);
  if (!actor) return err(new MembershipError(NOT_A_MEMBER_MESSAGE));
  if (actor.role !== "owner") return err(new MembershipError("Only an owner can delete the household."));
  const expected = input.householdName.trim();
  const typed = input.confirmation.trim();
  if (expected.length === 0 || typed.length > CONFIRMATION_MAX || typed !== expected) {
    return err(new MembershipError(DELETE_CONFIRMATION_MESSAGE));
  }
  const removedIds = householdRowsInScope(input.rows, input.householdId).map((row) => row.id);
  return ok({ householdId: input.householdId, removedIds });
}
