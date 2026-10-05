"use client";

import { categoryMenuSections, type CategoryMenuEntry } from "@dollas/domain";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createPayeeRuleAction, deletePayeeRuleAction, updatePayeeRuleAction } from "@/slices/activity/payee-rules";

const selectClass = "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm";

type Rule = {
  id: string;
  pattern: string;
  categoryId: string;
  categoryName: string;
};

export function PayeeRules({ rules, categories }: { rules: Rule[]; categories: CategoryMenuEntry[] }) {
  return (
    <div className="space-y-4">
      {rules.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No payee rules yet. New imports use the category column until you add one.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {rules.map((rule) => (
            <li key={`${rule.id}:${rule.pattern}:${rule.categoryId}`} className="py-3 first:pt-0 last:pb-0">
              <PayeeRuleRow rule={rule} categories={categories} />
            </li>
          ))}
        </ul>
      )}
      <PayeeRuleCreate categories={categories} />
    </div>
  );
}

function PayeeRuleCreate({ categories }: { categories: CategoryMenuEntry[] }) {
  const [state, action, pending] = useActionState(createPayeeRuleAction, { error: "" });
  if (categories.length === 0) {
    return <p className="text-sm text-muted-foreground">Add a category before saving a payee rule.</p>;
  }
  return (
    <form action={action} className="grid gap-3 md:grid-cols-[1fr_16rem_auto] md:items-end">
      <div className="space-y-1.5">
        <Label htmlFor="payee-rule-pattern">Payee contains</Label>
        <Input id="payee-rule-pattern" name="pattern" required />
      </div>
      <CategorySelect id="payee-rule-category" categories={categories} />
      <Button type="submit" className="h-8" disabled={pending}>
        {pending ? "Adding" : "Add rule"}
      </Button>
      {state.error ? (
        <p role="alert" className="text-sm text-over md:col-span-3">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

function PayeeRuleRow({ rule, categories }: { rule: Rule; categories: CategoryMenuEntry[] }) {
  const [state, action, pending] = useActionState(updatePayeeRuleAction, { error: "" });
  const [removed, remove, removing] = useActionState(deletePayeeRuleAction, { error: "" });
  const field = `payee-rule-${rule.id}`;
  return (
    <div className="space-y-2">
      <form action={action} className="grid gap-3 md:grid-cols-[1fr_16rem_auto] md:items-end">
        <input type="hidden" name="ruleId" value={rule.id} />
        <div className="space-y-1.5">
          <Label htmlFor={`${field}-pattern`}>Payee contains</Label>
          <Input id={`${field}-pattern`} name="pattern" defaultValue={rule.pattern} required />
        </div>
        <CategorySelect id={`${field}-category`} categories={categories} defaultValue={rule.categoryId} />
        <Button type="submit" className="h-8" disabled={pending}>
          {pending ? "Saving" : "Save"}
        </Button>
        {state.error ? (
          <p role="alert" className="text-sm text-over md:col-span-3">
            {state.error}
          </p>
        ) : null}
      </form>
      <form action={remove} className="flex items-center gap-3">
        <input type="hidden" name="ruleId" value={rule.id} />
        <Button type="submit" variant="ghost" className="h-8 px-0" disabled={removing}>
          {removing ? "Removing" : "Remove rule"}
        </Button>
        <span className="text-xs text-muted-foreground">Now: {rule.categoryName}</span>
        {removed.error ? (
          <p role="alert" className="text-sm text-over">
            {removed.error}
          </p>
        ) : null}
      </form>
    </div>
  );
}

function CategorySelect({
  id,
  categories,
  defaultValue,
}: {
  id: string;
  categories: CategoryMenuEntry[];
  defaultValue?: string;
}) {
  const menu = categoryMenuSections(categories);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Category</Label>
      {menu.isErr() ? (
        <p role="alert" className="text-sm text-over">
          {menu.error.message}
        </p>
      ) : (
        <select id={id} name="categoryId" className={selectClass} required defaultValue={defaultValue ?? categories[0]?.id}>
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
    </div>
  );
}
