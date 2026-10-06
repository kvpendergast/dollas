import Link from "next/link";
import { SignInForm } from "@/components/forms/auth-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { googleSignInEnabled } from "@/lib/auth";

export const dynamic = "force-dynamic";

function resetDone(value: string | string[] | undefined): boolean {
  if (Array.isArray(value)) return value.includes("1");
  return value === "1";
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string | string[] }>;
}) {
  const params = await searchParams;
  const saved = resetDone(params.reset);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Welcome back. The books are where you left them.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {saved ? <p className="text-sm text-foreground">Password saved. Sign in with the new one.</p> : null}
        <SignInForm googleEnabled={googleSignInEnabled()} />
        <p className="text-sm text-muted-foreground">
          New here?{" "}
          <Link href="/sign-up" className="text-primary underline-offset-4 hover:underline">
            Create a login
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
