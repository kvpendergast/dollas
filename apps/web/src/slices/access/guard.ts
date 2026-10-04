import {
  authorizeHouseholdAccess,
  civilDateInTimeZone,
  emailCountsAsVerified,
  type AuthProvider,
  type CivilDate,
  type HouseholdRole,
} from "@dollas/domain";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { withActor } from "@/db/actor";
import { account, household, householdMember } from "@/db/schema";
import { getDb } from "@/db/client";
import { getAuth } from "@/lib/auth";
import { logError } from "@/lib/telemetry";

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

export const getActorContext = cache(async () => {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return null;
  const providerRows = await getDb()
    .select({ providerId: account.providerId })
    .from(account)
    .where(eq(account.userId, session.user.id));
  const providers = asProviders(providerRows.map((row) => row.providerId));
  const base = {
    userId: session.user.id,
    emailVerified: Boolean(session.user.emailVerified),
    providers,
  };
  if (!emailCountsAsVerified(base)) {
    return { kind: "unverified" as const, session };
  }
  const memberships = await withActor(session.user.id, (tx) =>
    tx.select().from(householdMember).where(eq(householdMember.userId, session.user.id)),
  );
  return {
    kind: "verified" as const,
    session,
    actor: {
      ...base,
      memberships: memberships.map((row) => ({
        householdId: row.householdId,
        role: row.role === "owner" ? ("owner" as const) : ("member" as const),
      })),
    },
  };
});

export async function requireVerifiedUser() {
  const ctx = await getActorContext();
  if (!ctx) redirect("/sign-in");
  if (ctx.kind === "unverified") redirect("/verify-email");
  return ctx;
}

export const requireBooks = cache(async (): Promise<BooksContext> => {
  const ctx = await requireVerifiedUser();
  const membership = ctx.actor.memberships[0];
  if (!membership) redirect("/welcome");
  const grant = authorizeHouseholdAccess(ctx.actor, membership.householdId);
  if (grant.isErr()) {
    logError(grant.error, { userId: ctx.actor.userId, householdId: membership.householdId });
    redirect("/welcome");
  }
  const [house] = await withActor(ctx.actor.userId, (tx) =>
    tx.select().from(household).where(eq(household.id, membership.householdId)),
  );
  if (!house) redirect("/welcome");
  return {
    userId: ctx.actor.userId,
    userName: ctx.session.user.name,
    householdId: house.id,
    householdName: house.name,
    currency: house.currency,
    timezone: house.timezone,
    role: grant.value.role,
    asOf: civilDateInTimeZone(new Date(), house.timezone),
  };
});
