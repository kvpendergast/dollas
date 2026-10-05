"use client";

import { Tabs } from "radix-ui";
import { JoinHouseholdForm, StartHouseholdForm } from "@/components/forms/auth-forms";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const segmentClass = cn(
  "rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors",
  "hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
  "data-[state=active]:bg-primary data-[state=active]:text-primary-foreground",
  "data-[state=active]:hover:text-primary-foreground",
);

export function HouseholdChoice({
  defaultName = "",
  defaultCode = "",
}: {
  defaultName?: string;
  defaultCode?: string;
}) {
  return (
    <Tabs.Root defaultValue="start">
      <Card>
        <CardContent className="space-y-4">
          <Tabs.List aria-label="Household" className="grid grid-cols-2 rounded-lg bg-muted p-1">
            <Tabs.Trigger value="start" className={segmentClass}>
              Start
            </Tabs.Trigger>
            <Tabs.Trigger value="join" className={segmentClass}>
              Join
            </Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="start" className="space-y-3">
            <p className="text-sm text-muted-foreground">You own this set of books. Your login stays yours.</p>
            <StartHouseholdForm defaultName={defaultName} />
          </Tabs.Content>
          <Tabs.Content value="join" className="space-y-3">
            <p className="text-sm text-muted-foreground">A code from your person. Your login stays yours.</p>
            <JoinHouseholdForm defaultCode={defaultCode} />
          </Tabs.Content>
        </CardContent>
      </Card>
    </Tabs.Root>
  );
}
