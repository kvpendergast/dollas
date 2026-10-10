import { redirect } from "next/navigation";
import { HouseholdChoice } from "@/components/forms/household-choice";
import { Button } from "@/components/ui/button";
import { getActorContext } from "@/slices/access/guard";
import { readHouseholdIntent, signOutAction } from "@/slices/auth/actions";

export const dynamic = "force-dynamic";

export default async function WelcomePage({ searchParams }: { searchParams: Promise<{ path?: string | string[] }> }) {
  const ctx = await getActorContext();
  if (!ctx) redirect("/sign-in");
  if (ctx.kind === "unverified") redirect("/verify-email");
  if (ctx.actor.memberships.length > 0) redirect("/");
  const intent = await readHouseholdIntent();
  // Signed up from an invite link: go back to that invite instead of choosing.
  if (intent?.mode === "join") redirect(`/invite/${intent.inviteToken}`);
  const params = await searchParams;
  // The tab matches the path chosen at sign-up: the remembered intent, or ?path= from a Google sign-up.
  const defaultPath = params.path === "join" ? "join" : "start";
  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center gap-6 px-6 py-16">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="font-serif text-5xl text-primary">dollas</p>
          <p className="mt-2 text-sm text-muted-foreground">money for one household</p>
        </div>
        <form action={signOutAction}>
          <Button type="submit" variant="ghost" size="sm">
            Sign out
          </Button>
        </form>
      </div>
      <div>
        <h1 className="font-serif text-4xl tracking-tight">Set up your household</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Signed in as {ctx.kind === "verified" ? ctx.session.user.email : "you"}. Start a household, or join the one your partner started.
        </p>
      </div>
      <HouseholdChoice defaultName={intent?.mode === "start" ? intent.householdName : ""} defaultPath={defaultPath} />
    </main>
  );
}
