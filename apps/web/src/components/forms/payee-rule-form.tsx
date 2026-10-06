"use client";

import { categoryMenuSections, type CategoryMenuEntry } from "@dollas/domain";
import { useActionState, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { describePayeeRuleApply, describePayeeRuleRemoval } from "@/slices/activity/payee-rule-copy";
import {
  applyPayeeRuleAction,
  createPayeeRuleAction,
  deletePayeeRuleAction,
  previewPayeeRuleApplyAction,
  updatePayeeRuleAction,
  type PayeeRuleApplyPreview,
} from "@/slices/activity/payee-rules";

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
      <p className="text-sm text-muted-foreground">
        A longer match wins. Editing or deleting one transaction does not change the rule.
      </p>
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
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <RemovePayeeRule rule={rule} />
        <ApplyPayeeRule rule={rule} />
        <span className="text-xs text-muted-foreground">Now: {rule.categoryName}</span>
      </div>
    </div>
  );
}

function RemovePayeeRule({ rule }: { rule: Rule }) {
  const [removed, remove, removing] = useActionState(deletePayeeRuleAction, { error: "" });
  const copy = describePayeeRuleRemoval(rule);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" className="h-8 px-0">
          Remove rule
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.body}</DialogDescription>
        </DialogHeader>
        <form action={remove}>
          <input type="hidden" name="ruleId" value={rule.id} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="destructive" disabled={removing}>
              {removing ? "Removing" : "Remove rule"}
            </Button>
          </DialogFooter>
          {removed.error ? (
            <p role="alert" className="mt-3 text-sm text-over">
              {removed.error}
            </p>
          ) : null}
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ApplyPayeeRule({ rule }: { rule: Rule }) {
  const [preview, setPreview] = useState<PayeeRuleApplyPreview | null>(null);
  const [error, setError] = useState("");
  const [applied, setApplied] = useState("");
  const [checking, startCheck] = useTransition();
  const [applying, startApply] = useTransition();

  function openPreview() {
    setError("");
    setApplied("");
    startCheck(async () => {
      const result = await previewPayeeRuleApplyAction(rule.id);
      if (result.error) {
        setPreview(null);
        setError(result.error);
        return;
      }
      setPreview(result);
    });
  }

  function confirmApply() {
    setError("");
    startApply(async () => {
      const result = await applyPayeeRuleAction(rule.id);
      if (result.error) {
        setError(result.error);
        return;
      }
      setApplied(result.message);
    });
  }

  const copy = preview
    ? describePayeeRuleApply({
        pattern: preview.pattern,
        categoryName: preview.categoryName,
        changeCount: preview.changeCount,
        skippedSplitCount: preview.skippedSplitCount,
        skippedWithoutCategoryCount: preview.skippedWithoutCategoryCount,
      })
    : null;

  return (
    <>
      <Button type="button" variant="outline" className="h-8" disabled={checking} onClick={openPreview}>
        {checking ? "Checking" : "Apply to existing"}
      </Button>
      {error && !preview ? (
        <p role="alert" className="text-sm text-over">
          {error}
        </p>
      ) : null}
      <Dialog
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPreview(null);
            setApplied("");
            setError("");
          }
        }}
      >
        <DialogContent>
          {copy ? (
            <>
              <DialogHeader>
                <DialogTitle>{copy.title}</DialogTitle>
                <DialogDescription>{applied || copy.body}</DialogDescription>
              </DialogHeader>
              {error ? (
                <p role="alert" className="text-sm text-over">
                  {error}
                </p>
              ) : null}
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="outline">
                    {applied ? "Close" : "Cancel"}
                  </Button>
                </DialogClose>
                {applied ? null : (
                  <Button type="button" disabled={applying || preview?.changeCount === 0} onClick={confirmApply}>
                    {applying ? "Applying" : "Apply"}
                  </Button>
                )}
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
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
