"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { syncBankConnectionAction } from "@/slices/connections/actions";

export function SyncConnectionForm({ connectionId }: { connectionId: string }) {
  const [state, action, pending] = useActionState(syncBankConnectionAction, { error: "", message: "" });
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="connectionId" value={connectionId} />
      <Button type="submit" variant="secondary" className="h-8" disabled={pending}>
        {pending ? "Syncing" : "Sync"}
      </Button>
      {state.error ? (
        <p role="alert" className="text-sm text-over">
          {state.error}
        </p>
      ) : null}
      {state.message ? <p className="text-sm text-income">{state.message}</p> : null}
    </form>
  );
}
