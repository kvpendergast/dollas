"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createTransferAction } from "@/slices/activity/actions";
import { useActionToast } from "@/lib/use-action-toast";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Option = { id: string; name: string };

/** Money between two of the household's own accounts, such as a card payment. Neither income nor spending. */
export function TransferForm({ accounts, today }: { accounts: Option[]; today: string }) {
  const [state, action, pending] = useActionState(createTransferAction, { error: "" });
  useActionToast(state, "Transfer added.");
  if (accounts.length < 2) return null;
  return (
    <form action={action} className="space-y-3 border-t-2 border-dashed border-border-soft pt-4">
      <div>
        <h3 className="font-heading text-lg font-extrabold">Move money between accounts</h3>
        <p className="text-sm text-muted-foreground">
          A card payment or a move to savings. It is saved as two transactions in Transfers and does not count as income or spending.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="transferFrom">From</Label>
          <Select id="transferFrom" name="fromAccountId" defaultValue={accounts[0]?.id} required>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="transferTo">To</Label>
          <Select id="transferTo" name="toAccountId" defaultValue={accounts[1]?.id} required>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="transferAmount">Amount</Label>
          <Input id="transferAmount" name="amount" inputMode="decimal" placeholder="0.00" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="transferDate">Date</Label>
          <Input id="transferDate" name="occurredOn" type="date" defaultValue={today} required />
        </div>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-over">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Saving" : "Move it"}
      </Button>
    </form>
  );
}
