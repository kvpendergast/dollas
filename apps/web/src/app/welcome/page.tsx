import { redirect } from "next/navigation";
import { JoinHouseholdForm, StartHouseholdForm } from "@/components/forms/auth-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
    <main className="mx-auto flex min-h-full max-w-3xl flex-col justify-center gap-6 px-6 py-16">
      <div>
        <p className="font-serif text-5xl text-primary">dollas</p>
        <h1 className="mt-3 text-2xl">Where should these books live?</h1>
        <p className="mt-1 text-sm text-muted-foreground">One household, shared. Your login stays yours.</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Start a household</CardTitle>
            <CardDescription>You will be the owner of a new set of books.</CardDescription>
          </CardHeader>
          <CardContent>
            <StartHouseholdForm defaultName={intent?.mode === "start" ? intent.householdName : ""} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Join with an invite</CardTitle>
            <CardDescription>Use a code from someone already in the household.</CardDescription>
          </CardHeader>
          <CardContent>
            <JoinHouseholdForm defaultCode={intent?.mode === "join" ? intent.inviteCode : ""} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
