"use client";

import { Tabs } from "radix-ui";
import { JoinHouseholdForm, StartHouseholdForm } from "@/components/forms/auth-forms";
import { segmentClass } from "@/components/forms/sign-up-choice";
import { Card, CardContent } from "@/components/ui/card";

/** Welcome: opens on the path chosen at sign-up (PEN-204). */
export function HouseholdChoice({ defaultName = "", defaultPath = "start" }: { defaultName?: string; defaultPath?: "start" | "join" }) {
  return (
    <Tabs.Root defaultValue={defaultPath}>
      <Card>
        <CardContent className="space-y-4">
          <Tabs.List aria-label="Household" className="grid grid-cols-2 rounded-lg bg-muted p-1">
            <Tabs.Trigger value="start" className={segmentClass}>
              Start a household
            </Tabs.Trigger>
            <Tabs.Trigger value="join" className={segmentClass}>
              Join with an invite
            </Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="start" className="space-y-3">
            <p className="text-sm text-muted-foreground">You own this household. Your login stays yours.</p>
            <StartHouseholdForm defaultName={defaultName} />
          </Tabs.Content>
          <Tabs.Content value="join" className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Your person invites your email from their Household page. Open the link they sent, or paste it here.
            </p>
            <JoinHouseholdForm />
          </Tabs.Content>
        </CardContent>
      </Card>
    </Tabs.Root>
  );
}
