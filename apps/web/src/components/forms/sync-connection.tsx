"use client";

import { FieldError } from "@/components/ui/field";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { syncBankConnectionAction } from "@/slices/connections/actions";
import { useActionToast } from "@/lib/use-action-toast";

export function SyncConnectionForm({ connectionId }: { connectionId: string }) {
  const [state, action, pending] = useActionState(syncBankConnectionAction, { error: "", message: "" });
  useActionToast(state, (s) => s.message || "Bank synced.");
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="connectionId" value={connectionId} />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Syncing" : "Sync"}
      </Button>
      {state.error ? (
        <FieldError>
          {state.error}
        </FieldError>
      ) : null}
      {state.message ? <p className="text-sm text-income">{state.message}</p> : null}
    </form>
  );
}
