import Link from "next/link";
import { ResendVerificationForm } from "@/components/forms/auth-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { verificationEmailHelp } from "@/lib/verification-email";

export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string | string[] }>;
}) {
  const params = await searchParams;
  const email = first(params.email).trim().slice(0, 254);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Verify your email</CardTitle>
        <CardDescription>
          Open the link, then come back and sign in. The books stay closed until this address is verified.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm text-muted-foreground">
        <p>{verificationEmailHelp()}</p>
        <ResendVerificationForm defaultEmail={email} />
        <Link href="/sign-in" className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </CardContent>
    </Card>
  );
}
