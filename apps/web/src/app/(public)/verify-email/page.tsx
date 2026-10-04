import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { verificationEmailHelp } from "@/lib/verification-email";

export const dynamic = "force-dynamic";

export default function VerifyEmailPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Verify your email</CardTitle>
        <CardDescription>
          Email and password cannot open household books until the address is verified. Google sign-in counts as verified.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p>{verificationEmailHelp()}</p>
        <Link href="/sign-in" className="text-primary underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </CardContent>
    </Card>
  );
}
