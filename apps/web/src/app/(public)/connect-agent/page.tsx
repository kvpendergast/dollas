import Link from "next/link";
import { redirect } from "next/navigation";
import { AGENT_MESSAGES } from "@dollas/domain";
import { ConnectAgentForm } from "@/components/forms/agent-forms";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { searchParamsToQuery } from "@/lib/agent-oauth";
import { cn } from "@/lib/utils";
import { getActorContext } from "@/slices/access/guard";
import { agentHouseholdFor } from "@/slices/access/member";
import { describeAgentRequest } from "@/slices/agents/connections";

export const dynamic = "force-dynamic";
export const metadata = { title: "Connect an agent · dollas" };

function Notice({ title, message, href, label }: { title: string; message: string; href: string; label: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription role="alert" className="text-foreground">
          {message}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Link href={href} className={cn(buttonVariants({ variant: "outline" }), "h-10 w-full")}>
          {label}
        </Link>
      </CardContent>
    </Card>
  );
}

/**
 * OAuth consent screen. The provider redirects here with its signed query
 * after the member signs in. The member sees which household the agent gets
 * and picks read, or read and write.
 */
export default async function ConnectAgentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const oauthQuery = searchParamsToQuery(params);
  if (typeof params.client_id !== "string" || typeof params.sig !== "string") {
    return (
      <Notice
        title="Connect an agent"
        message="Start the connection from your agent. It will send you here to approve it."
        href="/"
        label="Go home"
      />
    );
  }
  const ctx = await getActorContext();
  if (!ctx) redirect(`/sign-in?${oauthQuery}`);
  if (ctx.kind === "unverified") {
    return (
      <Notice
        title="Verify your email first"
        message="Confirm your email, then connect the agent again. Google sign-in counts as verified."
        href="/verify-email"
        label="Verify email"
      />
    );
  }
  const books = await agentHouseholdFor(ctx.actor.userId);
  if (!books) {
    return <Notice title="Connect an agent" message={AGENT_MESSAGES.no_household} href="/welcome" label="Set up a household" />;
  }
  const request = await describeAgentRequest(ctx.actor.userId, new URLSearchParams(oauthQuery));
  if (!request.ok) {
    return <Notice title="Connect an agent" message={request.memberMessage} href="/" label="Go home" />;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect {request.value.clientName}</CardTitle>
        <CardDescription>
          {request.value.clientName} wants to use your Dollas books as you ({ctx.session.user.email}).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md bg-muted/50 p-3 text-sm">
          <p className="text-muted-foreground">Household</p>
          <p className="font-medium">{books.householdName}</p>
          <p className="text-xs text-muted-foreground">
            Agents connect to the household you are in. It sees what you see there and nothing from other households.
          </p>
        </div>
        <ConnectAgentForm oauthQuery={oauthQuery} canWrite={request.value.canWrite} />
      </CardContent>
    </Card>
  );
}
