"use client";

import { useActionState, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AuthFormState } from "@/slices/auth/actions";
import {
  acceptInviteAction,
  copyInviteLinkAction,
  createInviteAction,
  revokeInviteAction,
  type InviteFormState,
} from "@/slices/household/actions";

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Shows a link with a copy button. If the browser blocks the clipboard, the link stays selectable. */
function CopyableLink({ link }: { link: string }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "manual">("idle");
  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <Input readOnly value={link} aria-label="Invite link" className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <Button
          type="button"
          variant="outline"
          className="h-9"
          onClick={() => {
            void writeClipboard(link).then((ok) => setCopied(ok ? "copied" : "manual"));
          }}
        >
          {copied === "copied" ? "Copied" : "Copy link"}
        </Button>
      </div>
      {copied === "manual" ? <p className="text-xs text-muted-foreground">Select the link and copy it.</p> : null}
    </div>
  );
}

const initialInvite: InviteFormState = { error: "" };

export function InviteForm() {
  const [state, action, pending] = useActionState(createInviteAction, initialInvite);
  return (
    <div className="space-y-3">
      <form action={action} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="invite-email">Their email</Label>
          <div className="flex gap-2">
            <Input id="invite-email" name="email" type="email" autoComplete="off" placeholder="sam@example.com" required />
            <Button type="submit" className="h-9" disabled={pending}>
              {pending ? "Sending" : "Send invite"}
            </Button>
          </div>
        </div>
        {state.error ? (
          <p role="alert" className="text-sm text-over">
            {state.error}
          </p>
        ) : null}
      </form>
      {state.link ? (
        <div className="space-y-2 rounded-xl border border-border bg-muted/40 p-3">
          <p role="status" className="text-sm text-foreground">
            {state.notice}
          </p>
          <CopyableLink link={state.link} />
        </div>
      ) : null}
    </div>
  );
}

export function PendingInviteActions({ inviteId, email }: { inviteId: string; email: string }) {
  const [link, setLink] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              setError("");
              const result = await copyInviteLinkAction(inviteId);
              if (result.error || !result.link) {
                setError(result.error ?? "Could not copy that link.");
                return;
              }
              const ok = await writeClipboard(result.link);
              setLink(ok ? null : result.link);
              setMessage(ok ? "Link copied." : "");
            })
          }
        >
          Copy link
        </Button>
        {confirming ? (
          <>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const result = await revokeInviteAction(inviteId);
                  setConfirming(false);
                  if (result.error) setError(result.error);
                })
              }
            >
              Revoke invite for {email}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
          </>
        ) : (
          <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setConfirming(true)}>
            Revoke
          </Button>
        )}
        {message ? (
          <span role="status" className="text-xs text-muted-foreground">
            {message}
          </span>
        ) : null}
      </div>
      {link ? <CopyableLink link={link} /> : null}
      {error ? (
        <p role="alert" className="text-sm text-over">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const initialAuth: AuthFormState = { error: "" };

export function AcceptInviteForm({ token, householdName }: { token: string; householdName: string }) {
  const [state, action, pending] = useActionState(acceptInviteAction, initialAuth);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      {state.error ? (
        <p role="alert" className="text-sm text-over">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" className="h-10 w-full" disabled={pending}>
        {pending ? "Joining" : `Join the ${householdName} books`}
      </Button>
    </form>
  );
}
