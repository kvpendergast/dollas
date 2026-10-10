import Link from "next/link";
import { SignInForm } from "@/components/forms/auth-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isInviteToken } from "@dollas/domain";
import { agentAuthorizeReturnPath, isAgentLoginQuery, searchParamsToQuery } from "@/lib/agent-oauth";
import { googleSignInEnabled } from "@/lib/auth";

export const dynamic = "force-dynamic";

function resetDone(value: string | string[] | undefined): boolean {
  if (Array.isArray(value)) return value.includes("1");
  return value === "1";
}

function description(invite: string | undefined, agent: string | undefined): string {
  if (agent) return "Sign in to connect an agent to your household. You will confirm what it can do next.";
  if (invite) return "Sign in with the email your invite was sent to. You will go straight back to the invite.";
  return "Welcome back. Your household is where you left it.";
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const saved = resetDone(params.reset);
  const invite = typeof params.invite === "string" && isInviteToken(params.invite) ? params.invite : undefined;
  // The OAuth provider sends members here mid-connection with its signed query.
  const agentReturn = isAgentLoginQuery(params) ? (agentAuthorizeReturnPath(searchParamsToQuery(params)) ?? undefined) : undefined;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{agentReturn ? "Connect an agent" : "Sign in"}</CardTitle>
        <CardDescription>{description(invite, agentReturn)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {saved ? <p className="text-sm text-foreground">Password saved. Sign in with the new one.</p> : null}
        <SignInForm googleEnabled={googleSignInEnabled()} invite={agentReturn ? undefined : invite} agentReturn={agentReturn} />
        <p className="text-sm text-muted-foreground">
          New here?{" "}
          <Link href={invite && !agentReturn ? `/sign-up?invite=${invite}` : "/sign-up"} className="text-primary underline-offset-4 hover:underline">
            Create a login
          </Link>
          {agentReturn ? " and set up your household first, then connect the agent again." : null}
        </p>
      </CardContent>
    </Card>
  );
}
