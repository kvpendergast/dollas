import { InviteButton } from "@/components/forms/invite-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireBooks } from "@/slices/access/guard";
import { loadInvites } from "@/slices/books/queries";

export default async function HouseholdPage() {
  const books = await requireBooks();
  const active = await loadInvites(books);
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="font-serif text-4xl">{books.householdName}</h1>
        <p className="text-sm text-muted-foreground">Send a code. Your person gets their own login.</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Invites</CardTitle>
          <CardDescription>Codes work until they expire. Nobody shares a password.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {active.length === 0 ? <p className="text-sm text-muted-foreground">No invites out yet.</p> : null}
          <ul className="space-y-2">
            {active.map((invite) => (
              <li key={invite.id} className="flex items-baseline justify-between gap-3">
                <span className="font-serif text-2xl tracking-wide">{invite.code}</span>
                <span className="text-xs text-muted-foreground">until {invite.expiresAt.toISOString().slice(0, 10)}</span>
              </li>
            ))}
          </ul>
          <InviteButton />
        </CardContent>
      </Card>
    </div>
  );
}
