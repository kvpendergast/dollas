import Link from "next/link";
import { ResetPasswordForm } from "@/components/forms/auth-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; error?: string | string[] }>;
}) {
  const params = await searchParams;
  const token = first(params.token);
  const invalid = first(params.error) === "INVALID_TOKEN" || token.length < 8;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Choose a new password</CardTitle>
        <CardDescription>This replaces the old one. The link works once.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {invalid ? (
          <div className="space-y-3 text-sm">
            <p>That link has expired or was already used.</p>
            <Link
              href="/forgot-password"
              className="inline-flex min-h-11 items-center text-primary underline-offset-4 hover:underline"
            >
              Send a new link
            </Link>
          </div>
        ) : (
          <ResetPasswordForm token={token} />
        )}
      </CardContent>
    </Card>
  );
}
