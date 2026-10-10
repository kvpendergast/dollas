import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { AcceptInviteForm } from "@/components/forms/invite-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { getActorContext } from "@/slices/access/guard";
import { signOutForInviteAction } from "@/slices/household/actions";
import { previewHouseholdInvite } from "@/slices/household/invites";

export const dynamic = "force-dynamic";
export const metadata = { title: "Invite · Dollas" };

function day(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

async function viewer() {
  const ctx = await getActorContext();
  if (!ctx) return null;
  if (ctx.kind === "unverified") {
    return { userId: ctx.session.user.id, email: ctx.session.user.email, verified: false, memberOf: [] as string[] };
  }
  return {
    userId: ctx.actor.userId,
    email: ctx.session.user.email,
    verified: true,
    memberOf: ctx.actor.memberships.map((membership) => membership.householdId),
  };
}

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const me = await viewer();
  const visit = await previewHouseholdInvite(token, me);

  if (visit.kind === "invalid" || visit.kind === "closed") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{visit.kind === "closed" ? `Invite to ${visit.preview.householdName}` : "Invite link"}</CardTitle>
          <CardDescription role="alert" className="text-foreground">
            {visit.message}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href={me ? "/" : "/sign-in"} className={cn(buttonVariants({ variant: "outline" }), "h-10 w-full")}>
            {me ? "Go home" : "Go to sign in"}
          </Link>
        </CardContent>
      </Card>
    );
  }

  const { preview } = visit;
  const header = (
    <CardHeader>
      <CardTitle>Join the {preview.householdName} household</CardTitle>
      <CardDescription>
        {preview.invitedBy} invited you. You get your own login and see the same accounts, transactions, categories, and
        budget.
      </CardDescription>
    </CardHeader>
  );

  if (visit.kind === "already_member") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{preview.householdName}</CardTitle>
          <CardDescription>You are already in this household.</CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/" className={cn(buttonVariants(), "h-10 w-full")}>
            Go to Home
          </Link>
        </CardContent>
      </Card>
    );
  }

  if (visit.kind === "signed_out") {
    return (
      <Card>
        {header}
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            This invite is for <span className="font-medium text-foreground">{preview.maskedEmail}</span> and works until{" "}
            {day(preview.expiresAt)}. Sign in or create a login with that email.
          </p>
          <Link href={`/sign-up?invite=${token}`} className={cn(buttonVariants(), "h-10 w-full")}>
            Create a login
          </Link>
          <Link href={`/sign-in?invite=${token}`} className={cn(buttonVariants({ variant: "outline" }), "h-10 w-full")}>
            I already have a login
          </Link>
        </CardContent>
      </Card>
    );
  }

  if (visit.kind === "blocked") {
    return (
      <Card>
        {header}
        <CardContent className="space-y-3">
          <p role="alert" className="text-sm text-over">
            {visit.message}
          </p>
          {visit.reason === "wrong_email" ? (
            <>
              <p className="text-sm text-muted-foreground">
                You are signed in as {me?.email}. This invite is for {preview.maskedEmail}.
              </p>
              <form action={signOutForInviteAction}>
                <input type="hidden" name="token" value={token} />
                <button type="submit" className={cn(buttonVariants({ variant: "outline" }), "h-10 w-full")}>
                  Sign out and use another login
                </button>
              </form>
            </>
          ) : null}
          {visit.reason === "unverified" ? (
            <Link href="/verify-email" className={cn(buttonVariants({ variant: "outline" }), "h-10 w-full")}>
              Verify my email
            </Link>
          ) : null}
          {visit.reason === "other_household" ? (
            <Link href="/settings" className={cn(buttonVariants({ variant: "outline" }), "h-10 w-full")}>
              Open Settings
            </Link>
          ) : null}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      {header}
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">{me?.email}</span>.
        </p>
        <AcceptInviteForm token={token} householdName={preview.householdName} />
      </CardContent>
    </Card>
  );
}
