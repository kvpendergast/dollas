"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import {
  addStarterCategoriesAction,
  dismissOnboardingAction,
  resumeOnboardingAction,
  type OnboardingFormState,
} from "@/slices/onboarding/actions";
import { useActionToast } from "@/lib/use-action-toast";

const initial: OnboardingFormState = { error: "" };

function Status({ state }: { state: OnboardingFormState }) {
  if (state.error) {
    return (
      <p role="alert" className="text-sm text-over">
        {state.error}
      </p>
    );
  }
  return state.notice ? (
    <p role="status" className="text-sm text-muted-foreground">
      {state.notice}
    </p>
  ) : null;
}

export function SkipOnboardingButton({ label = "Skip for now" }: { label?: string }) {
  const [state, action, pending] = useActionState(dismissOnboardingAction, initial);
  useActionToast(state, "Checklist hidden. Bring it back from Home or Settings.");
  return (
    <form action={action} className="space-y-1">
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        {pending ? "Hiding" : label}
      </Button>
      {state.error ? <Status state={state} /> : null}
    </form>
  );
}

export function ResumeOnboardingButton({ variant = "link" }: { variant?: "link" | "outline" }) {
  const [state, action, pending] = useActionState(resumeOnboardingAction, initial);
  useActionToast(state, "The setup checklist is back on Home.");
  return (
    <form action={action} className="space-y-1">
      <Button type="submit" variant={variant} size="sm" className={variant === "link" ? "h-auto px-0" : undefined} disabled={pending}>
        {pending ? "Bringing it back" : "Resume setup checklist"}
      </Button>
      <Status state={state} />
    </form>
  );
}

export function StarterCategoriesButton({ variant = "default" }: { variant?: "default" | "outline" }) {
  const [state, action, pending] = useActionState(addStarterCategoriesAction, initial);
  useActionToast(state, (s) => s.notice || "Starter categories added.");
  return (
    <form action={action} className="space-y-1">
      <Button type="submit" variant={variant} size="sm" disabled={pending}>
        {pending ? "Adding" : "Add starter categories"}
      </Button>
      <Status state={state} />
    </form>
  );
}
