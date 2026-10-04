"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setBudgetAction } from "@/slices/plan/actions";

export function BudgetForm({ categoryId, defaultDollars }: { categoryId: string; defaultDollars: string }) {
  const [state, action, pending] = useActionState(setBudgetAction, { error: "" });
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="categoryId" value={categoryId} />
      <Input name="amount" aria-label="Monthly budget" defaultValue={defaultDollars} inputMode="decimal" className="w-28" />
      <Button type="submit" size="sm" variant="secondary" disabled={pending}>
        Save
      </Button>
      {state.error ? (
        <span role="alert" className="text-xs text-over">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
