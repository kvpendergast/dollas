"use client";

import { categoryMenuSections } from "@dollas/domain";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createTransactionAction } from "@/slices/activity/actions";

type Option = { id: string; name: string };

type CategoryOption = Option & {
  kind: string;
  sortOrder: number;
  groupId: string | null;
  groupName: string | null;
  groupSort: number | null;
};

export function TransactionForm({
  accounts,
  categories,
  today,
}: {
  accounts: Option[];
  categories: CategoryOption[];
  today: string;
}) {
  const [state, action, pending] = useActionState(createTransactionAction, { error: "" });
  const [split, setSplit] = useState(false);
  return (
    <form action={action} className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="payee">Payee</Label>
          <Input id="payee" name="payee" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="occurredOn">Date</Label>
          <Input id="occurredOn" name="occurredOn" type="date" defaultValue={today} required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="accountId">Account</Label>
          <select id="accountId" name="accountId" className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm" required>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="direction">Direction</Label>
          <select id="direction" name="direction" className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm" defaultValue="expense">
            <option value="expense">Expense</option>
            <option value="income">Income</option>
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="amount">Amount</Label>
          <Input id="amount" name="amount" inputMode="decimal" placeholder="0.00" required />
        </div>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="category-0">Category</Label>
          <button type="button" className="text-sm text-primary" onClick={() => setSplit((value) => !value)}>
            {split ? "One category" : "Split it"}
          </button>
        </div>
        <CategoryRow categories={categories} index={0} showAmount={split} />
        {split ? <CategoryRow categories={categories} index={1} showAmount /> : null}
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-over">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" className="h-10" disabled={pending}>
        {pending ? "Saving" : "Add it"}
      </Button>
    </form>
  );
}

function CategoryRow({
  categories,
  index,
  showAmount,
}: {
  categories: CategoryOption[];
  index: number;
  showAmount: boolean;
}) {
  const menu = categoryMenuSections(categories);
  return (
    <div className="grid gap-2 md:grid-cols-[1fr_8rem]">
      {menu.isErr() ? (
        <p role="alert" className="text-sm text-over">
          {menu.error.message}
        </p>
      ) : (
        <select
          id={`category-${index}`}
          name="categoryId"
          aria-label={index === 0 ? "Category" : "Split category"}
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
          defaultValue={menu.value[0]?.items[0]?.id}
          required
        >
          {menu.value.map((section) => (
            <optgroup key={section.id} label={section.label}>
              {section.items.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      )}
      {showAmount ? (
        <Input name="splitAmount" inputMode="decimal" placeholder="0.00" aria-label="Split amount" required />
      ) : null}
    </div>
  );
}
