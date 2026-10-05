"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { createInviteAction } from "@/slices/household/actions";

export function InviteButton() {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <div className="space-y-2">
      <Button
        type="button"
        className="h-10"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void createInviteAction().then((result) => {
            setPending(false);
            if (result.error) setError(result.error);
            if (result.code) setCode(result.code);
          });
        }}
      >
        {pending ? "Making the invite" : "Make an invite"}
      </Button>
      {code ? <p className="font-serif text-2xl tracking-wide">{code}</p> : null}
      {error ? (
        <p role="alert" className="text-sm text-over">
          {error}
        </p>
      ) : null}
    </div>
  );
}
