import { redirect } from "next/navigation";
import { HouseholdChoice } from "@/components/forms/household-choice";
import { getActorContext } from "@/slices/access/guard";
import { readHouseholdIntent } from "@/slices/auth/actions";

export const dynamic = "force-dynamic";

export default async function WelcomePage() {
  const ctx = await getActorContext();
  if (!ctx) redirect("/sign-in");
  if (ctx.kind === "unverified") redirect("/verify-email");
  if (ctx.actor.memberships.length > 0) redirect("/");
  const intent = await readHouseholdIntent();
  return (
    <main className="mx-auto flex min-h-full w-full max-w-md flex-col justify-center gap-6 px-6 py-16">
      <div>
        <p className="font-serif text-5xl text-primary">dollas</p>
        <h1 className="mt-3 text-2xl">Where should these books live?</h1>
        <p className="mt-1 text-sm text-muted-foreground">One household, shared. Your login stays yours.</p>
      </div>
      <HouseholdChoice
        defaultName={intent?.mode === "start" ? intent.householdName : ""}
        defaultCode={intent?.mode === "join" ? intent.inviteCode : ""}
      />
    </main>
  );
}
