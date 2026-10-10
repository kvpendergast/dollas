import { authorizeHouseholdAccess, civilDateInTimeZone, emailCountsAsVerified } from "@dollas/domain";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { withActor } from "@/db/actor";
import { household } from "@/db/schema";
import { getAuth } from "@/lib/auth";
import { logError } from "@/lib/telemetry";
import { loadMemberActor, type BooksContext } from "@/slices/access/member";

export type { BooksContext };

export const getActorContext = cache(async () => {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return null;
  const memberActor = await loadMemberActor(session.user.id, Boolean(session.user.emailVerified));
  const base = {
    userId: memberActor.userId,
    emailVerified: memberActor.emailVerified,
    providers: memberActor.providers,
  };
  if (!emailCountsAsVerified(base)) {
    return { kind: "unverified" as const, session };
  }
  return {
    kind: "verified" as const,
    session,
    actor: memberActor,
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
