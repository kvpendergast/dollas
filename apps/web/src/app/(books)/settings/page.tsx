import { NameForm, EmailForm, PasswordSection, TransferForm, LeaveHouseholdDialog, DeleteHouseholdDialog } from "@/components/forms/settings-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireBooks } from "@/slices/access/guard";
import { describeMembership } from "@/slices/settings/membership";

export const metadata = { title: "Settings · dollas" };

export default async function SettingsPage() {
  const books = await requireBooks();
  const described = await describeMembership({ userId: books.userId, householdId: books.householdId });
  const profile = described.ok ? described.value : null;
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
