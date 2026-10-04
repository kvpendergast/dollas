import Link from "next/link";
import { SignInForm } from "@/components/forms/auth-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { googleAuthEnabled } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Open the shared household books.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <SignInForm googleEnabled={googleAuthEnabled} />
        <p className="text-sm text-muted-foreground">
          New here?{" "}
          <Link href="/sign-up" className="text-primary underline-offset-4 hover:underline">
            Create an account
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
