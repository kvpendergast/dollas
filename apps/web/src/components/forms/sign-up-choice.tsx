"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SignUpForm } from "@/components/forms/auth-forms";

/** Start a household or join one: only the chosen path's fields show (PEN-204). */
export function SignUpChoice({ googleEnabled, defaultPath }: { googleEnabled: boolean; defaultPath: "start" | "join" }) {
  return (
    <Tabs defaultValue={defaultPath} className="space-y-4">
      <TabsList aria-label="How are you starting?" className="grid w-full grid-cols-2">
        <TabsTrigger value="start" className="text-center whitespace-normal">
          Start a household
        </TabsTrigger>
        <TabsTrigger value="join" className="text-center whitespace-normal">
          Join with an invite
        </TabsTrigger>
      </TabsList>
      <TabsContent value="start" className="space-y-3">
        <p className="text-sm text-muted-foreground">You create the household and can invite your partner after.</p>
        <SignUpForm googleEnabled={googleEnabled} path="start" />
      </TabsContent>
      <TabsContent value="join" className="space-y-3">
        <p className="text-sm text-muted-foreground">Someone already started the household and invited your email.</p>
        <SignUpForm googleEnabled={googleEnabled} path="join" />
      </TabsContent>
    </Tabs>
  );
}
