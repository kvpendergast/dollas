import Link from "next/link";
import { isInviteToken } from "@dollas/domain";
import { SignUpForm } from "@/components/forms/auth-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { googleSignInEnabled } from "@/lib/auth";
import { previewHouseholdInvite } from "@/slices/household/invites";

export const dynamic = "force-dynamic";

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ invite?: string | string[] }> }) {
  const params = await searchParams;
  const token = typeof params.invite === "string" && isInviteToken(params.invite) ? params.invite : undefined;
  const visit = token ? await previewHouseholdInvite(token, null) : null;
  const invite = token && visit?.kind === "signed_out" ? { token, maskedEmail: visit.preview.maskedEmail } : undefined;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Create a login</CardTitle>
        <CardDescription>
          {invite && visit?.kind === "signed_out"
            ? `${visit.preview.invitedBy} invited you to the ${visit.preview.householdName} books. Your login stays yours. Email and password stay locked until the address is verified.`
            : "Start the books. Email and password stay locked until the address is verified."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <SignUpForm googleEnabled={googleSignInEnabled()} invite={invite} />
        <p className="text-sm text-muted-foreground">
          Already have a login?{" "}
          <Link href={invite ? `/sign-in?invite=${invite.token}` : "/sign-in"} className="text-primary underline-offset-4 hover:underline">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
