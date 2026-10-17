"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { JoinHouseholdForm, StartHouseholdForm } from "@/components/forms/auth-forms";
import { Card, CardContent } from "@/components/ui/card";

/** Welcome: opens on the path chosen at sign-up (PEN-204). */
export function HouseholdChoice({ defaultName = "", defaultPath = "start" }: { defaultName?: string; defaultPath?: "start" | "join" }) {
  return (
    <Tabs defaultValue={defaultPath}>
      <Card>
        <CardContent className="space-y-4">
          <TabsList aria-label="Household" className="grid w-full grid-cols-2">
            <TabsTrigger value="start" className="text-center whitespace-normal">
              Start a household
            </TabsTrigger>
            <TabsTrigger value="join" className="text-center whitespace-normal">
              Join with an invite
            </TabsTrigger>
          </TabsList>
          <TabsContent value="start" className="space-y-3">
            <p className="text-sm text-muted-foreground">You own this household. Your login stays yours.</p>
            <StartHouseholdForm defaultName={defaultName} />
          </TabsContent>
          <TabsContent value="join" className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Your person invites your email from their Household page. Open the link they sent, or paste it here.
            </p>
            <JoinHouseholdForm />
          </TabsContent>
        </CardContent>
      </Card>
    </Tabs>
  );
}
