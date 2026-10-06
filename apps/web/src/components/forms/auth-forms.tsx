"use client";

import { cooldownCopy } from "@dollas/domain";
import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
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

const initial: AuthFormState = { error: "" };

export function SignInForm({ googleEnabled }: { googleEnabled: boolean }) {
  const [state, action, pending] = useActionState(signInAction, initial);
  return (
    <div className="space-y-4">
      <form action={action} className="space-y-3">
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
      <GoogleButton enabled={googleEnabled} />
    </div>
  );
}

export function SignUpForm({ googleEnabled }: { googleEnabled: boolean }) {
  const [state, action, pending] = useActionState(signUpAction, initial);
  return (
    <div className="space-y-4">
      <form action={action} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="name">Your name</Label>
          <Input id="name" name="name" autoComplete="name" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input id="password" name="password" type="password" autoComplete="new-password" minLength={8} required />
        </div>
        <fieldset className="space-y-3 rounded-xl border border-border p-3">
          <legend className="px-1 text-sm font-medium">The books</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="mode" value="start" defaultChecked className="mt-1" />
            <span className="flex-1 space-y-1.5">
              <span className="block">Start a household</span>
              <Input name="householdName" placeholder="Household name" aria-label="Household name" />
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" name="mode" value="join" className="mt-1" />
            <span className="flex-1 space-y-1.5">
              <span className="block">Join with an invite</span>
              <Input name="inviteCode" placeholder="Invite code" aria-label="Invite code" autoCapitalize="characters" />
            </span>
          </label>
        </fieldset>
        {state.error ? (
          <p role="alert" className="text-sm text-over">
            {state.error}
          </p>
        ) : null}
        <Button type="submit" className="h-10 w-full" disabled={pending}>
          {pending ? "Creating login" : "Create a login"}
        </Button>
      </form>
      <GoogleButton enabled={googleEnabled} />
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
        Start the books
      </Button>
    </form>
  );
}

export function JoinHouseholdForm({ defaultCode = "" }: { defaultCode?: string }) {
  const [state, action, pending] = useActionState(joinHouseholdAction, initial);
  return (
    <form action={action} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="inviteCode">Invite code</Label>
        <Input id="inviteCode" name="inviteCode" defaultValue={defaultCode} autoCapitalize="characters" required />
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-over">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" className="h-10 w-full" disabled={pending}>
        Join the books
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

function GoogleButton({ enabled }: { enabled: boolean }) {
  if (!enabled) {
    return (
      <p className="text-xs text-muted-foreground">
        Google sign-in counts as a verified email. It is not turned on here.
      </p>
    );
  }
  return (
    <Button
      type="button"
      variant="outline"
      className="h-10 w-full"
      onClick={() => {
        void authClient.signIn.social({ provider: "google", callbackURL: "/" });
      }}
    >
      Continue with Google
    </Button>
  );
}
