import Link from "next/link";
import { ForgotPasswordForm } from "@/components/forms/auth-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Forgot your password?</CardTitle>
        <CardDescription>
          We&apos;ll email a link if this address has a login. It expires in an hour and works once.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ForgotPasswordForm />
        <Link href="/sign-in" className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline">
          Back to sign in
        </Link>
      </CardContent>
    </Card>
  );
}
