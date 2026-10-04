"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createAccountAction } from "@/slices/accounts/actions";

export function AccountForm() {
  const [state, action, pending] = useActionState(createAccountAction, { error: "" });
  return (
    <form action={action} className="grid gap-3 md:grid-cols-[1fr_10rem_8rem_auto] md:items-end">
      <div className="space-y-1.5">
        <Label htmlFor="account-name">Name</Label>
        <Input id="account-name" name="name" required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="account-type">Type</Label>
        <select id="account-type" name="type" className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm" defaultValue="checking">
          <option value="checking">Checking</option>
          <option value="savings">Savings</option>
          <option value="credit">Credit</option>
          <option value="cash">Cash</option>
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="opening">Opening balance</Label>
        <Input id="opening" name="opening" inputMode="decimal" defaultValue="0.00" />
      </div>
      <Button type="submit" className="h-8" disabled={pending}>
        Add account
      </Button>
      {state.error ? (
        <p role="alert" className="text-sm text-over md:col-span-4">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
