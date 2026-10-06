"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setBudgetAction } from "@/slices/plan/actions";

export function BudgetForm({
  categoryId,
  categoryName,
  month,
  defaultDollars,
}: {
  categoryId: string;
  categoryName: string;
  month: string;
  defaultDollars: string;
}) {
  const [state, action, pending] = useActionState(setBudgetAction, { error: "" });
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="categoryId" value={categoryId} />
      <input type="hidden" name="month" value={month} />
      <Input
        name="amount"
        aria-label={`${categoryName} monthly budget`}
        defaultValue={defaultDollars}
        inputMode="decimal"
        placeholder="No budget"
        className="w-28"
      />
      <Button type="submit" name="intent" value="save" size="sm" variant="secondary" disabled={pending}>
        Save
      </Button>
      <Button type="submit" name="intent" value="clear" size="sm" variant="ghost" disabled={pending}>
        Clear
      </Button>
      {state.error ? (
        <span role="alert" className="text-xs text-over">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
