"use client";

import { FieldError } from "@/components/ui/field";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { disconnectBankConnectionAction } from "@/slices/connections/actions";
import { useActionToast } from "@/lib/use-action-toast";

export function DisconnectConnectionForm({ connectionId, label }: { connectionId: string; label: string }) {
  const [state, action, pending] = useActionState(disconnectBankConnectionAction, { error: "" });
  useActionToast(state, "Bank disconnected. Its transactions stay.");
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="connectionId" value={connectionId} />
      <Button type="submit" variant="destructive" disabled={pending} aria-label={`Disconnect ${label}`}>
        {pending ? "Disconnecting" : "Disconnect"}
      </Button>
      {state.error ? (
        <FieldError>
          {state.error}
        </FieldError>
      ) : null}
    </form>
  );
}
