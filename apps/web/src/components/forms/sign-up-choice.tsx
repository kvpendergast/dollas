"use client";

import { Tabs } from "radix-ui";
import { SignUpForm } from "@/components/forms/auth-forms";
import { cn } from "@/lib/utils";

export const segmentClass = cn(
  "rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors",
  "hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
  "data-[state=active]:bg-primary data-[state=active]:text-primary-foreground",
  "data-[state=active]:hover:text-primary-foreground",
);

/** Start a household or join one: only the chosen path's fields show (PEN-204). */
export function SignUpChoice({ googleEnabled, defaultPath }: { googleEnabled: boolean; defaultPath: "start" | "join" }) {
  return (
    <Tabs.Root defaultValue={defaultPath} className="space-y-4">
      <Tabs.List aria-label="How are you starting?" className="grid grid-cols-2 rounded-lg bg-muted p-1">
        <Tabs.Trigger value="start" className={segmentClass}>
          Start a household
        </Tabs.Trigger>
        <Tabs.Trigger value="join" className={segmentClass}>
          Join with an invite
        </Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="start" className="space-y-3">
        <p className="text-sm text-muted-foreground">You create the household and can invite your partner after.</p>
        <SignUpForm googleEnabled={googleEnabled} path="start" />
      </Tabs.Content>
      <Tabs.Content value="join" className="space-y-3">
        <p className="text-sm text-muted-foreground">Someone already started the household and invited your email.</p>
        <SignUpForm googleEnabled={googleEnabled} path="join" />
      </Tabs.Content>
    </Tabs.Root>
  );
}
