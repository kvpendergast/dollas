"use client";

import { CREDIT_OWED_HINT } from "@dollas/domain";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createAccountAction } from "@/slices/accounts/actions";
import { useActionToast } from "@/lib/use-action-toast";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export function AccountForm() {
  const [state, action, pending] = useActionState(createAccountAction, { error: "" });
  useActionToast(state, "Account added.");
  const [type, setType] = useState("checking");
  const [owed, setOwed] = useState(false);
  const credit = type === "credit";

  return (
    <form action={action} className="space-y-3">
      <div className="grid gap-3 md:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="account-name">Name</Label>
          <Input id="account-name" name="name" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="account-type">Type</Label>
          <Select
            id="account-type"
            name="type"
           
            value={type}
            onChange={(event) => {
              const next = event.target.value;
              setType(next);
              setOwed(next === "credit");
            }}
          >
            <option value="checking">Checking</option>
            <option value="savings">Savings</option>
            <option value="credit">Credit</option>
            <option value="cash">Cash</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="opening">{credit && owed ? "Amount owed" : "Opening balance"}</Label>
          <Input id="opening" name="opening" inputMode="decimal" defaultValue="0.00" />
        </div>
      </div>
      {credit ? (
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            name="owed"
            value="yes"
            className="mt-1 size-4 accent-primary"
            checked={owed}
            onChange={(event) => setOwed(event.target.checked)}
          />
          <span>
            <span className="font-medium">Owed</span>
            <span className="mt-1 block text-muted-foreground">{CREDIT_OWED_HINT}</span>
          </span>
        </label>
      ) : null}
      {state.error ? (
        <p role="alert" className="text-sm text-over">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Adding" : "Add account"}
      </Button>
    </form>
  );
}
