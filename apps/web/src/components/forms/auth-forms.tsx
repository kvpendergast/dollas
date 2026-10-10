"use client";

import { cooldownCopy } from "@dollas/domain";
import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { GoogleSignInButton } from "@/components/forms/google-sign-in-button";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import {
  requestPasswordResetAction,
  resendVerificationAction,
  resetPasswordAction,
  signInAction,
  signUpAction,
  type AuthFormState,
} from "@/slices/auth/actions";
import { joinHouseholdAction, startHouseholdAction } from "@/slices/household/actions";
import { useActionToast } from "@/lib/use-action-toast";

const initial: AuthFormState = { error: "" };

export function SignInForm({
  googleEnabled,
  invite,
  agentReturn,
}: {
  googleEnabled: boolean;
  invite?: string;
  /** Provider authorize path to resume an agent connection after sign-in. */
  agentReturn?: string;
}) {
  const [state, action, pending] = useActionState(signInAction, initial);
  const returnTo = agentReturn ?? (invite ? `/invite/${invite}` : "/");
  return (
    <div className="space-y-4">
      <form action={action} className="space-y-3">
        {invite ? <input type="hidden" name="invite" value={invite} /> : null}
        {agentReturn ? <input type="hidden" name="agentReturn" value={agentReturn} /> : null}
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="password">Password</Label>
            <Link
              href="/forgot-password"
              className="inline-flex min-h-11 items-center text-sm text-primary underline-offset-4 hover:underline"
            >
              Forgot password?
            </Link>
          </div>
          <Input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        {state.unverifiedEmail ? (
          <div role="alert" className="space-y-3">
            <p className="text-sm text-foreground">{state.error}</p>
            <Link
              href={`/verify-email?email=${encodeURIComponent(state.unverifiedEmail)}`}
              className={cn(buttonVariants({ variant: "outline" }), "h-10 w-full")}
            >
              Send a verification link
            </Link>
          </div>
        ) : state.error ? (
          <p role="alert" className="text-sm text-over">
            {state.error}
          </p>
        ) : null}
        <Button type="submit" className="h-10 w-full" disabled={pending}>
          {pending ? "Signing in" : "Sign in"}
        </Button>
      </form>
      <GoogleSignInButton
        enabled={googleEnabled}
        onSignIn={() => {
          void authClient.signIn.social({ provider: "google", callbackURL: returnTo });
        }}
      />
    </div>
  );
}

/**
 * One sign-up path at a time (PEN-204): "start" asks for the household name;
 * "join" asks for the invite link, unless it came in the URL.
 */
export function SignUpForm({
  googleEnabled,
  path,
  invite,
}: {
  googleEnabled: boolean;
  path: "start" | "join";
  invite?: { token: string; maskedEmail: string };
}) {
  const [state, action, pending] = useActionState(signUpAction, initial);
  const returnTo = invite ? `/invite/${invite.token}` : `/welcome?path=${path}`;
  const id = (name: string) => `${path}-${name}`;
  return (
    <div className="space-y-4">
      <form action={action} className="space-y-3">
        <input type="hidden" name="path" value={path} />
        {invite ? <input type="hidden" name="invite" value={invite.token} /> : null}
        <div className="space-y-1.5">
          <Label htmlFor={id("name")}>Your name</Label>
          <Input id={id("name")} name="name" autoComplete="name" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={id("email")}>Email</Label>
          <Input id={id("email")} name="email" type="email" autoComplete="email" required />
          {invite ? (
            <p className="text-xs text-muted-foreground">Use the address the invite was sent to ({invite.maskedEmail}).</p>
          ) : path === "join" ? (
            <p className="text-xs text-muted-foreground">Use the address your invite was sent to.</p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={id("password")}>Password</Label>
          <Input id={id("password")} name="password" type="password" autoComplete="new-password" minLength={8} required />
        </div>
        {path === "start" ? (
          <div className="space-y-1.5">
            <Label htmlFor={id("householdName")}>Household name</Label>
            <Input id={id("householdName")} name="householdName" placeholder="The Maple house" required />
          </div>
        ) : invite ? null : (
          <div className="space-y-1.5">
            <Label htmlFor={id("inviteLink")}>Invite link</Label>
            <Input id={id("inviteLink")} name="inviteLink" placeholder="https://…/invite/…" autoComplete="off" required />
            <p className="text-xs text-muted-foreground">
              Paste the link from the invite email. No invite yet? Ask them to invite your email from their Household page.
            </p>
          </div>
        )}
        {state.error ? (
          <p role="alert" className="text-sm text-over">
            {state.error}
          </p>
        ) : null}
        <Button type="submit" className="h-10 w-full" disabled={pending}>
          {pending ? "Creating login" : path === "start" ? "Create login and household" : "Create login and join"}
        </Button>
      </form>
      <GoogleSignInButton
        enabled={googleEnabled}
        onSignIn={() => {
          void authClient.signIn.social({ provider: "google", callbackURL: returnTo });
        }}
      />
    </div>
  );
}

export function StartHouseholdForm({ defaultName = "" }: { defaultName?: string }) {
  const [state, action, pending] = useActionState(startHouseholdAction, initial);
  return (
    <form action={action} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="householdName">Household name</Label>
        <Input id="householdName" name="householdName" defaultValue={defaultName} required />
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-over">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" className="h-10 w-full" disabled={pending}>
        Start the household
      </Button>
    </form>
  );
}

export function JoinHouseholdForm() {
  const [state, action, pending] = useActionState(joinHouseholdAction, initial);
  return (
    <form action={action} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="inviteLink">Invite link</Label>
        <Input id="inviteLink" name="inviteLink" placeholder="https://…/invite/…" autoComplete="off" required />
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-over">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" className="h-10 w-full" disabled={pending}>
        Open the invite
      </Button>
    </form>
  );
}

function useCountdown(seconds: number, generation: number) {
  const [remaining, setRemaining] = useState(seconds);
  const [trackedGeneration, setTrackedGeneration] = useState(generation);
  const generationChanged = generation !== trackedGeneration;
  if (generationChanged) {
    setTrackedGeneration(generation);
    setRemaining(seconds);
  }
  const shown = generationChanged ? seconds : remaining;
  useEffect(() => {
    if (shown <= 0) return;
    const id = window.setTimeout(() => {
      setRemaining((value) => Math.max(0, value - 1));
    }, 1000);
    return () => window.clearTimeout(id);
  }, [shown]);
  return shown;
}

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState(requestPasswordResetAction, initial);
  useActionToast(state, (s) => s.notice || null);
  return (
    <form action={action} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      {state.notice ? (
        <p role="status" className="text-sm text-foreground">
          {state.notice}
        </p>
      ) : null}
      {state.error ? (
        <p role="alert" className="text-sm text-over">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" className="h-10 w-full" disabled={pending}>
        {pending ? "Sending" : "Email me a link"}
      </Button>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(resetPasswordAction, initial);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <div className="space-y-1.5">
        <Label htmlFor="password">New password</Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={8} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirm">Confirm password</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={8} required />
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-over">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" className="h-10 w-full" disabled={pending}>
        {pending ? "Saving" : "Save password"}
      </Button>
    </form>
  );
}

export function ResendVerificationForm({ defaultEmail }: { defaultEmail: string }) {
  const [state, action, pending] = useActionState(resendVerificationAction, initial);
  useActionToast(state, (s) => s.notice || null);
  const [wasPending, setWasPending] = useState(pending);
  const [generation, setGeneration] = useState(0);
  if (pending !== wasPending) {
    setWasPending(pending);
    if (wasPending && !pending) setGeneration((value) => value + 1);
  }
  const remaining = useCountdown(state.retryAfterSeconds ?? 0, generation);
  return (
    <form action={action} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          defaultValue={defaultEmail}
          required
        />
      </div>
      {state.notice ? (
        <p role="status" className="text-sm text-foreground">
          {state.notice}
        </p>
      ) : null}
      {remaining > 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          {cooldownCopy(remaining)}
        </p>
      ) : state.error ? (
        <p role="alert" className="text-sm text-over">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" className="h-10 w-full" disabled={pending || remaining > 0}>
        {pending ? "Sending" : "Send another link"}
      </Button>
    </form>
  );
}

