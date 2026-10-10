import Link from "next/link";
import { SignInForm } from "@/components/forms/auth-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isInviteToken } from "@dollas/domain";
import { googleSignInEnabled } from "@/lib/auth";

export const dynamic = "force-dynamic";

function resetDone(value: string | string[] | undefined): boolean {
  if (Array.isArray(value)) return value.includes("1");
  return value === "1";
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string | string[]; invite?: string | string[] }>;
}) {
  const params = await searchParams;
  const saved = resetDone(params.reset);
  const invite = typeof params.invite === "string" && isInviteToken(params.invite) ? params.invite : undefined;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>
          {invite
            ? "Sign in with the email your invite was sent to. You will go straight back to the invite."
            : "Welcome back. The books are where you left them."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {saved ? <p className="text-sm text-foreground">Password saved. Sign in with the new one.</p> : null}
        <SignInForm googleEnabled={googleSignInEnabled()} invite={invite} />
        <p className="text-sm text-muted-foreground">
          New here?{" "}
          <Link href={invite ? `/sign-up?invite=${invite}` : "/sign-up"} className="text-primary underline-offset-4 hover:underline">
            Create a login
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
