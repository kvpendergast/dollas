"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createPlaidLinkTokenAction, linkPlaidAction } from "@/slices/connections/actions";

const PLAID_LINK_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

type PlaidLinkMetadata = {
  institution?: { name?: string | null } | null;
};

type PlaidHandler = {
  open: () => void;
  destroy: () => void;
};

type PlaidGlobal = {
  create: (config: {
    token: string;
    onSuccess: (publicToken: string, metadata: PlaidLinkMetadata) => void;
    onExit: (error: { error_code?: string } | null) => void;
  }) => PlaidHandler;
};

export function PlaidLinkForm({ enabled }: { enabled: boolean }) {
  if (!enabled) return null;
  return <PlaidLinkFields />;
}

function PlaidLinkFields() {
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const sinceRef = useRef<HTMLInputElement>(null);

  async function start() {
    setError("");
    setMessage("");
    setPending(true);
    const since = sinceRef.current?.value ?? "";
    try {
      const created = await createPlaidLinkTokenAction(since);
      if (created.error || !created.linkToken) {
        setError(created.error || "Could not link that bank.");
        return;
      }
      await openPlaidLink(created.linkToken, async (publicToken, institution) => {
        const linked = await linkPlaidAction(publicToken, institution, since);
        if (linked.error) setError(linked.error);
        else setMessage(linked.message);
      });
    } catch {
      setError("Could not link that bank.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="plaid-since">Transactions since</Label>
        <Input ref={sinceRef} id="plaid-since" name="since" type="date" className="h-10 md:max-w-xs" />
        <p className="text-xs text-muted-foreground">
          Leave this blank to start 90 days ago. Plaid opens in a window from Plaid. Your bank password stays there
          and is not stored in Dollas. Pending charges stay off the books until they post.
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-over">
          {error}
        </p>
      ) : null}
      {message ? <p className="text-sm text-income">{message}</p> : null}
      <Button type="button" className="h-10" disabled={pending} onClick={() => void start()}>
        {pending ? "Linking" : "Link with Plaid"}
      </Button>
    </div>
  );
}

function openPlaidLink(
  linkToken: string,
  onPublicToken: (publicToken: string, institution: string) => Promise<void>,
): Promise<void> {
  return loadPlaidScript().then(
    () =>
      new Promise((resolve, reject) => {
        const plaid = (window as Window & { Plaid?: PlaidGlobal }).Plaid;
        if (!plaid) {
          reject(new Error("missing"));
          return;
        }
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const handler = plaid.create({
          token: linkToken,
          onSuccess: (publicToken, metadata) => {
            const institution = metadata.institution?.name ?? "";
            void onPublicToken(publicToken, institution).finally(() => {
              handler.destroy();
              finish();
            });
          },
          onExit: (exitError) => {
            handler.destroy();
            if (exitError) {
              reject(new Error("exit"));
              return;
            }
            finish();
          },
        });
        handler.open();
      }),
  );
}

function loadPlaidScript(): Promise<void> {
  if ((window as Window & { Plaid?: PlaidGlobal }).Plaid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>("script[data-plaid-link]");
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("script")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = PLAID_LINK_SRC;
    script.async = true;
    script.dataset.plaidLink = "true";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("script"));
    document.head.appendChild(script);
  });
}
