"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { connectAgentAction, revokeAgentAction, type AgentFormState } from "@/slices/agents/actions";
import { useActionToast } from "@/lib/use-action-toast";

const initial: AgentFormState = { error: "" };

export function ConnectAgentForm({ oauthQuery, canWrite }: { oauthQuery: string; canWrite: boolean }) {
  const [state, action, pending] = useActionState(connectAgentAction, initial);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="oauth_query" value={oauthQuery} />
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">What can it do?</legend>
        <RadioGroup name="access" defaultValue="read" aria-label="What can it do?">
          <label
            htmlFor="access-read"
            className="flex cursor-pointer items-start gap-3 rounded-md border-2 border-foreground p-3 text-sm has-[[data-state=checked]]:bg-secondary"
          >
            <RadioGroupItem id="access-read" value="read" className="mt-0.5" />
            <span>
              <span className="font-bold">Read</span>
              <span className="block text-muted-foreground">See accounts, balances, transactions, categories, and the plan.</span>
            </span>
          </label>
          <label
            htmlFor="access-read-write"
            className={`flex items-start gap-3 rounded-md border-2 border-foreground p-3 text-sm has-[[data-state=checked]]:bg-secondary ${canWrite ? "cursor-pointer" : "opacity-60"}`}
          >
            <RadioGroupItem id="access-read-write" value="read_write" disabled={!canWrite} className="mt-0.5" />
            <span>
              <span className="font-bold">Read and write</span>
              <span className="block text-muted-foreground">
                {canWrite ? "Also add and change things in your household, as you." : "This agent only asked to read."}
              </span>
            </span>
          </label>
        </RadioGroup>
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
        <Button type="submit" name="decision" value="accept" className="flex-1" disabled={pending}>
          {pending ? "Connecting" : "Connect"}
        </Button>
        <Button type="submit" name="decision" value="deny" variant="outline" className="flex-1" disabled={pending}>
          Deny
        </Button>
      </div>
    </form>
  );
}

export function DisconnectAgentForm({ connectionId, clientName }: { connectionId: string; clientName: string }) {
  const [state, action, pending] = useActionState(revokeAgentAction, initial);
  useActionToast(state, "Agent disconnected. Its access ended right away.");
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
