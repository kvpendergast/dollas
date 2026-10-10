import { INVITE_TTL_DAYS } from "@dollas/domain";
import { InviteForm, PendingInviteActions } from "@/components/forms/invite-forms";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireBooks } from "@/slices/access/guard";
import { listHouseholdPeople } from "@/slices/household/invites";

export const metadata = { title: "Household · Dollas" };

function day(date: Date, timeZone: string): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone });
}

export default async function HouseholdPage() {
  const books = await requireBooks();
  const people = await listHouseholdPeople({ userId: books.userId, householdId: books.householdId });
  const owner = people.ok && people.value.role === "owner";
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="font-serif text-4xl">{books.householdName}</h1>
        <p className="text-sm text-muted-foreground">
          Everyone here sees and edits the same accounts, transactions, categories, and budget. Each person has their own
          login.
        </p>
      </div>
      {!people.ok ? (
        <p role="alert" className="text-sm text-over">
          {people.memberMessage}
        </p>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Members</CardTitle>
              <CardDescription>Owners can invite, revoke invites, and hand off the household in Settings.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-border" aria-label="Members">
                {people.value.members.map((member) => (
                  <li key={member.userId} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {member.name}
                        {member.you ? <span className="text-muted-foreground"> (you)</span> : null}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{member.email}</p>
                    </div>
                    <Badge variant={member.role === "owner" ? "default" : "secondary"}>
                      {member.role === "owner" ? "Owner" : "Member"}
                    </Badge>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Invites</CardTitle>
              <CardDescription>
                {owner
                  ? `Invite by email. The link works once, for ${INVITE_TTL_DAYS} days, and only for a login with that email. Nobody shares a password.`
                  : "Only an owner can invite someone or revoke an invite."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {owner ? <InviteForm /> : null}
              <div className="space-y-2">
                <h2 className="text-sm font-medium">Waiting to join</h2>
                {people.value.invites.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No open invites.</p>
                ) : (
                  <ul className="divide-y divide-border" aria-label="Open invites">
                    {people.value.invites.map((invite) => (
                      <li key={invite.id} className="space-y-2 py-2.5">
                        <div className="flex items-baseline justify-between gap-3">
                          <p className="truncate text-sm font-medium">{invite.email}</p>
                          <p className="shrink-0 text-xs text-muted-foreground">
                            expires {day(invite.expiresAt, books.timezone)}
                          </p>
                        </div>
                        {owner ? <PendingInviteActions inviteId={invite.id} email={invite.email} /> : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
