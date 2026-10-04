import { err, ok, type Result } from "neverthrow";
import { HouseholdAccessError, UnverifiedEmailError } from "../errors";

export type AuthProvider = "credential" | "google";

export type HouseholdRole = "owner" | "member";

export type Membership = {
  householdId: string;
  role: HouseholdRole;
};

/**
 * The person asking to see a household.
 * Google sign-in counts as a verified email even when the password-style
 * verified flag is still false. Email and password do not.
 */
export type Actor = {
  userId: string;
  emailVerified: boolean;
  providers: readonly AuthProvider[];
  memberships: readonly Membership[];
};

export type HouseholdGrant = {
  userId: string;
  householdId: string;
  role: HouseholdRole;
};

export function emailCountsAsVerified(actor: Pick<Actor, "emailVerified" | "providers">): boolean {
  if (actor.providers.includes("google")) return true;
  return actor.emailVerified;
}

export function authorizeHouseholdAccess(
  actor: Actor,
  householdId: string,
): Result<HouseholdGrant, UnverifiedEmailError | HouseholdAccessError> {
  if (!emailCountsAsVerified(actor)) {
    return err(new UnverifiedEmailError());
  }
  const membership = actor.memberships.find((item) => item.householdId === householdId);
  if (!membership) {
    return err(new HouseholdAccessError());
  }
  return ok({
    userId: actor.userId,
    householdId,
    role: membership.role,
  });
}
