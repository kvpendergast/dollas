"use client";

import { categoryMenuSections, directionDefaultForKind, type CategoryMenuEntry, type TransactionDirection } from "@dollas/domain";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createTransactionAction } from "@/slices/activity/actions";
import { SplitControl } from "./split-control";

type Option = { id: string; name: string };

const selectClass = "h-10 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm";

function openingCategory(categories: readonly CategoryMenuEntry[]): { id: string; direction: TransactionDirection } {
  const menu = categoryMenuSections([...categories]);
  const id = menu.isOk() ? (menu.value[0]?.items[0]?.id ?? "") : (categories[0]?.id ?? "");
  const kind = categories.find((category) => category.id === id)?.kind ?? "";
  return { id, direction: directionDefaultForKind(kind) ?? "expense" };
}

export function TransactionForm({
  accounts,
  categories,
  today,
}: {
  accounts: Option[];
  categories: CategoryMenuEntry[];
  today: string;
}) {
  const [state, action, pending] = useActionState(createTransactionAction, { error: "" });
  const opening = openingCategory(categories);
  return (
    <form action={action} className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="payee">Payee</Label>
          <Input id="payee" name="payee" className="h-10" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="occurredOn">Date</Label>
          <Input id="occurredOn" name="occurredOn" className="h-10" type="date" defaultValue={today} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="accountId">Account</Label>
          {accounts.length === 0 ? (
            <p id="accountId" className="text-sm text-muted-foreground">
              Unarchive an account to add a transaction.
            </p>
          ) : (
            <select id="accountId" name="accountId" className={selectClass} required>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="amount">Amount</Label>
          <Input id="amount" name="amount" className="h-10" inputMode="decimal" placeholder="0.00" required />
        </div>
      </div>
      <SplitControl
        fieldId="entry"
        categories={categories}
        initialDirection={opening.direction}
        initialRows={[{ key: "primary", categoryId: opening.id, amount: "" }]}
        initialSplit={false}
      />
      {state.error ? (
        <p role="alert" className="text-sm text-over">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" className="h-10" disabled={pending || accounts.length === 0}>
        {pending ? "Saving" : "Add it"}
      </Button>
    </form>
  );
}
