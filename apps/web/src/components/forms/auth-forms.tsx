"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { signInAction, signUpAction, type AuthFormState } from "@/slices/auth/actions";
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
          <Label htmlFor="password">Password</Label>
          <Input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        {state.error ? (
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

function GoogleButton({ enabled }: { enabled: boolean }) {
  if (!enabled) {
    return (
      <p className="text-xs text-muted-foreground">
        Google sign-in counts as a verified email. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to turn it on.
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
