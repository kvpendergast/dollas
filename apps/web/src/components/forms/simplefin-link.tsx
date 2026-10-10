"use client";

import { useActionState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { linkSimpleFinAction } from "@/slices/connections/actions";
import { useActionToast } from "@/lib/use-action-toast";

export function SimpleFinLinkForm() {
  const [state, action, pending] = useActionState(linkSimpleFinAction, { error: "", message: "" });
  useActionToast(state, (s) => s.message || "Bank linked.");
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.message) formRef.current?.reset();
  }, [state.message]);

  return (
    <form ref={formRef} action={action} className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="simplefin-token">Setup token</Label>
          <Input
            id="simplefin-token"
            name="token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="h-10"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="simplefin-label">Name</Label>
          <Input id="simplefin-label" name="label" className="h-10" placeholder="SimpleFIN" maxLength={80} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="simplefin-since">Transactions since</Label>
        <Input id="simplefin-since" name="since" type="date" className="h-10 md:max-w-xs" />
        <p className="text-xs text-muted-foreground">
          Leave this blank to start 90 days ago. Later syncs keep this date, and pending charges are added once they
          post.
        </p>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-over">
          {state.error}
        </p>
      ) : null}
      {state.message ? <p className="text-sm text-income">{state.message}</p> : null}
      <Button type="submit" className="h-10" disabled={pending}>
        {pending ? "Linking" : "Link SimpleFIN"}
      </Button>
    </form>
  );
}
