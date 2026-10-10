import {
  authorizeHouseholdAccess,
  civilDateInTimeZone,
  type Actor,
  type AuthProvider,
  type CivilDate,
  type HouseholdRole,
} from "@dollas/domain";
import { eq } from "drizzle-orm";
import { withActor } from "@/db/actor";
import { getDb } from "@/db/client";
import { account, household, householdMember, user } from "@/db/schema";

/**
 * Who a member is, without a browser session. The web guard (session cookie)
 * and the MCP endpoint (OAuth access token) both resolve the member through
 * here, so both see households through the same rules and the same RLS.
 */
export type BooksContext = {
  userId: string;
  userName: string;
  householdId: string;
  householdName: string;
  currency: string;
  timezone: string;
  role: HouseholdRole;
  asOf: CivilDate;
};

function asProviders(values: string[]): AuthProvider[] {
  return values.filter((value): value is AuthProvider => value === "credential" || value === "google");
}

export async function loadMemberActor(userId: string, emailVerified: boolean): Promise<Actor> {
  const providerRows = await getDb()
    .select({ providerId: account.providerId })
    .from(account)
    .where(eq(account.userId, userId));
  const memberships = await withActor(userId, (tx) =>
    tx.select().from(householdMember).where(eq(householdMember.userId, userId)),
  );
  return {
    userId,
    emailVerified,
    providers: asProviders(providerRows.map((row) => row.providerId)),
    memberships: memberships.map((row) => ({
      householdId: row.householdId,
      role: row.role === "owner" ? ("owner" as const) : ("member" as const),
    })),
  };
}

/**
 * Books for one member in one household, or null when the member cannot open
 * it (unverified, not a member, household gone). The household row is read
 * through RLS, so a stale or forged household id finds nothing.
 */
export async function loadBooksForMember(userId: string, householdId: string): Promise<BooksContext | null> {
  const [person] = await getDb()
    .select({ name: user.name, emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.id, userId));
  if (!person) return null;
  const actor = await loadMemberActor(userId, person.emailVerified);
  const grant = authorizeHouseholdAccess(actor, householdId);
  if (grant.isErr()) return null;
  const [house] = await withActor(userId, (tx) => tx.select().from(household).where(eq(household.id, householdId)));
  if (!house) return null;
  return {
    userId,
    userName: person.name,
    householdId: house.id,
    householdName: house.name,
    currency: house.currency,
    timezone: house.timezone,
    role: grant.value.role,
    asOf: civilDateInTimeZone(new Date(), house.timezone),
  };
}

/** The household a member's agent connects to. One household per login today. */
export async function agentHouseholdFor(userId: string): Promise<BooksContext | null> {
  const [person] = await getDb()
    .select({ emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.id, userId));
  if (!person) return null;
  const actor = await loadMemberActor(userId, person.emailVerified);
  const membership = actor.memberships[0];
  if (!membership) return null;
  return loadBooksForMember(userId, membership.householdId);
}
