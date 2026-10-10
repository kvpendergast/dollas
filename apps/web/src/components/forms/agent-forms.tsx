"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { connectAgentAction, revokeAgentAction, type AgentFormState } from "@/slices/agents/actions";

const initial: AgentFormState = { error: "" };

export function ConnectAgentForm({ oauthQuery, canWrite }: { oauthQuery: string; canWrite: boolean }) {
  const [state, action, pending] = useActionState(connectAgentAction, initial);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="oauth_query" value={oauthQuery} />
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">What can it do?</legend>
        <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm has-[:checked]:border-primary">
          <input type="radio" name="access" value="read" defaultChecked className="mt-1" />
          <span>
            <span className="font-medium">Read</span>
            <span className="block text-muted-foreground">See accounts, balances, transactions, categories, and the plan.</span>
          </span>
        </label>
        <label
          className={`flex items-start gap-3 rounded-md border p-3 text-sm has-[:checked]:border-primary ${canWrite ? "cursor-pointer" : "opacity-60"}`}
        >
          <input type="radio" name="access" value="read_write" disabled={!canWrite} className="mt-1" />
          <span>
            <span className="font-medium">Read and write</span>
            <span className="block text-muted-foreground">
              {canWrite ? "Also add and change things in the books, as you." : "This agent only asked to read."}
            </span>
          </span>
        </label>
      </fieldset>
      <p className="text-xs text-muted-foreground">
        It never sees bank passwords or bank connection keys. You can disconnect it any time in Settings.
      </p>
      {state.error ? (
        <p role="alert" className="text-sm text-over">
          {state.error}
        </p>
      ) : null}
      <div className="flex gap-3">
        <Button type="submit" name="decision" value="accept" className="h-10 flex-1" disabled={pending}>
          {pending ? "Connecting" : "Connect"}
        </Button>
        <Button type="submit" name="decision" value="deny" variant="outline" className="h-10 flex-1" disabled={pending}>
          Deny
        </Button>
      </div>
    </form>
  );
}

export function DisconnectAgentForm({ connectionId, clientName }: { connectionId: string; clientName: string }) {
  const [state, action, pending] = useActionState(revokeAgentAction, initial);
  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="connectionId" value={connectionId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending} aria-label={`Disconnect ${clientName}`}>
        {pending ? "Disconnecting" : "Disconnect"}
      </Button>
      {state.error ? (
        <p role="alert" className="text-xs text-over">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
