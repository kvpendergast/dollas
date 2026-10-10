import { NameForm, EmailForm, PasswordSection, TransferForm, LeaveHouseholdDialog, DeleteHouseholdDialog } from "@/components/forms/settings-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireBooks } from "@/slices/access/guard";
import { describeMembership } from "@/slices/settings/membership";
import { DisconnectAgentForm } from "@/components/forms/agent-forms";
import { mcpResourceUrl } from "@/lib/agent-oauth";
import { listAgentConnections } from "@/slices/agents/connections";
import Link from "next/link";
import { ResumeOnboardingButton, SkipOnboardingButton } from "@/components/onboarding/onboarding-forms";
import { getOnboardingStatus } from "@/slices/onboarding/service";

function day(date: Date | null, timezone: string): string {
  if (!date) return "Not yet";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: timezone });
}

export const metadata = { title: "Settings · Dollas" };

export default async function SettingsPage() {
  const books = await requireBooks();
  const described = await describeMembership({ userId: books.userId, householdId: books.householdId });
  const profile = described.ok ? described.value : null;
  const agents = await listAgentConnections({ userId: books.userId, householdId: books.householdId });
  const onboarding = await getOnboardingStatus(books);
  const setup = onboarding.ok ? onboarding.value : null;
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="font-serif text-4xl tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Your login, and your place in {books.householdName}.</p>
      </div>
      {described.ok ? null : (
        <p role="alert" className="text-sm text-over">
          {described.memberMessage}
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Your name</CardTitle>
          <CardDescription>This is the name other people in the household see.</CardDescription>
        </CardHeader>
        <CardContent>
          <NameForm name={profile?.name ?? books.userName} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Email</CardTitle>
          <CardDescription>The new address has to be confirmed. The current one keeps working until then.</CardDescription>
        </CardHeader>
        <CardContent>{profile ? <EmailForm email={profile.email} /> : null}</CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>
            {profile?.signIn === "google"
              ? "This login uses Google."
              : "Use your current password to choose a new one."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PasswordSection method={profile?.signIn ?? "password"} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Connected agents</CardTitle>
          <CardDescription>
            AI agents you connected over MCP. Each acts as you in {books.householdName}. Disconnecting one stops it right away.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!agents.ok ? (
            <p role="alert" className="text-sm text-over">
              {agents.memberMessage}
            </p>
          ) : agents.value.length === 0 ? (
            <p className="text-sm text-muted-foreground">No agents are connected yet. The address to add is below.</p>
          ) : (
            <ul className="divide-y divide-border">
              {agents.value.map((agent) => (
                <li key={agent.id} className="flex items-start justify-between gap-3 py-3 text-sm first:pt-0">
                  <div className="space-y-0.5">
                    <p className="font-medium">{agent.clientName}</p>
                    <p className="text-muted-foreground">{agent.access}</p>
                    <p className="text-xs text-muted-foreground">
                      Connected {day(agent.connectedAt, books.timezone)} · Last used {day(agent.lastUsedAt, books.timezone)}
                    </p>
                  </div>
                  <DisconnectAgentForm connectionId={agent.id} clientName={agent.clientName} />
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            To connect one, add <span className="font-mono">{mcpResourceUrl()}</span> as a remote MCP server in your agent. It
            sends you here to sign in and choose read, or read and write.
          </p>
        </CardContent>
      </Card>
      {setup ? (
        <Card id="setup">
          <CardHeader>
            <CardTitle>Setup checklist</CardTitle>
            <CardDescription>
              {setup.requiredDone} of {setup.requiredTotal} steps done
              {setup.state === "dismissed"
                ? ". It is hidden on Home for everyone in the household."
                : setup.state === "complete"
                  ? ". Your household is set up."
                  : ". It is on Home for everyone in the household."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            {setup.state === "dismissed" ? (
              <ResumeOnboardingButton variant="outline" />
            ) : (
              <>
                <Link href="/" className="tap text-sm font-medium text-primary underline-offset-4 hover:underline">
                  Open it on Home
                </Link>
                <SkipOnboardingButton label={setup.state === "complete" ? "Hide it" : "Skip for now"} />
              </>
            )}
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>{books.householdName}</CardTitle>
          <CardDescription>
            You are {profile?.role === "owner" ? "an owner" : "a member"}. Leaving sends you back to start or join a household.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ul className="space-y-2">
            {(profile?.members ?? []).map((member) => (
              <li key={member.userId} className="flex items-baseline justify-between gap-3 text-sm">
                <span>
                  {member.name}
                  {member.userId === books.userId ? <span className="text-muted-foreground"> · You</span> : null}
                </span>
                <span className="text-muted-foreground">{member.role === "owner" ? "Owner" : "Member"}</span>
              </li>
            ))}
          </ul>
          {profile?.role === "owner" ? <TransferForm members={profile.members} /> : null}
          <div className="flex flex-wrap gap-3">
            <LeaveHouseholdDialog lastOwner={profile?.lastOwner ?? false} householdName={books.householdName} />
            {profile?.role === "owner" ? <DeleteHouseholdDialog householdName={books.householdName} /> : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
