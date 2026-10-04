import Link from "next/link";
import { SignUpForm } from "@/components/forms/auth-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { googleAuthEnabled } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default function SignUpPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Create an account</CardTitle>
        <CardDescription>Start a household, or join one with an invite. Email and password stay locked until the address is verified.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <SignUpForm googleEnabled={googleAuthEnabled} />
        <p className="text-sm text-muted-foreground">
          Already have a login?{" "}
          <Link href="/sign-in" className="text-primary underline-offset-4 hover:underline">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
