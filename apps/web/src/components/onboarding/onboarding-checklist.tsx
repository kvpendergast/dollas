import type { OnboardingStatus } from "@/slices/onboarding/service";
import Link from "next/link";
import { Check } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { SkipOnboardingButton, StarterCategoriesButton } from "./onboarding-forms";

function Progress({ done, total }: { done: number; total: number }) {
  const share = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground tabular-nums">
        {done} of {total} done
      </p>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-label="Setup progress"
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${share}%` }} />
      </div>
    </div>
  );
}

function Mark({ done }: { done: boolean }) {
  return done ? (
    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground" aria-hidden="true">
      <Check className="size-3.5" strokeWidth={3} />
    </span>
  ) : (
    <span className="mt-0.5 size-5 shrink-0 rounded-full border-2 border-border" aria-hidden="true" />
  );
}

/** The setup checklist on Home (PEN-204). Not a wizard: each step links to the page where it happens. */
export function OnboardingChecklist({ status }: { status: OnboardingStatus }) {
  if (status.state === "dismissed") return null;
  if (status.state === "complete") {
    const recurring = status.steps.find((step) => step.id === "recurring" && !step.done);
    return (
      <Card className="border-primary/20">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <CardTitle>Your household is set up</CardTitle>
              <CardDescription>Accounts, categories, transactions, a budget, and your partner are in.</CardDescription>
            </div>
            <SkipOnboardingButton label="Hide" />
          </div>
        </CardHeader>
        {recurring ? (
          <CardContent>
            <p className="text-sm text-muted-foreground">
              One optional step left:{" "}
              <Link href={recurring.href} className="font-medium text-primary underline-offset-4 hover:underline">
                {recurring.title.toLowerCase()}
              </Link>
              . {recurring.detail}
            </p>
          </CardContent>
        ) : null}
      </Card>
    );
  }
  return (
    <Card className="border-primary/20" aria-labelledby="setup-title">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle id="setup-title">Set up your household</CardTitle>
            <CardDescription>A few steps to get real numbers on Home. Each one checks itself off.</CardDescription>
          </div>
          <SkipOnboardingButton />
        </div>
        <Progress done={status.requiredDone} total={status.requiredTotal} />
      </CardHeader>
      <CardContent>
        <ol className="divide-y divide-border">
          {status.steps.map((step) => {
            const next = step.id === status.nextStep;
            return (
              <li key={step.id} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                <Mark done={step.done} />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className={cn("text-sm font-medium", step.done && "text-muted-foreground line-through decoration-1")}>
                    {step.title}
                    {step.optional ? <span className="ml-2 text-xs font-normal text-muted-foreground">Optional</span> : null}
                  </p>
                  {step.done ? null : (
                    <>
                      <p className="text-sm text-muted-foreground">{step.detail}</p>
                      <div className="flex flex-wrap items-start gap-2 pt-1">
                        {step.id === "categories" && status.offerStarterCategories ? (
                          <>
                            <StarterCategoriesButton variant={next ? "default" : "outline"} />
                            <Link href={step.href} className={cn(buttonVariants({ variant: "ghost", size: "sm" }))}>
                              Make my own
                            </Link>
                          </>
                        ) : (
                          <Link href={step.href} className={cn(buttonVariants({ variant: next ? "default" : "outline", size: "sm" }))}>
                            {step.action}
                          </Link>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
