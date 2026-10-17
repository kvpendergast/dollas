"use client";

import { FieldError } from "@/components/ui/field";
import { TRANSFER_KIND_HELP, categoryKindLabel, categoryKinds } from "@dollas/domain";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createCategoryAction, createCategoryGroupAction } from "@/slices/categories/actions";
import { useActionToast } from "@/lib/use-action-toast";
import { RadioGroup, RadioPill } from "@/components/ui/radio-group";
import { Select } from "@/components/ui/select";

export function CategoryGroupForm() {
  const [state, action, pending] = useActionState(createCategoryGroupAction, { error: "" });
  useActionToast(state, "Group added.");
  return (
    <form action={action} className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
      <div className="space-y-1.5">
        <Label htmlFor="group-name">Group name</Label>
        <Input id="group-name" name="name" required />
      </div>
      <Button type="submit" disabled={pending}>
        Add group
      </Button>
      {state.error ? (
        <FieldError className="md:col-span-2">
          {state.error}
        </FieldError>
      ) : null}
    </form>
  );
}

function KindChoices({ locked = false }: { locked?: boolean }) {
  return (
    <div className="space-y-2">
      <fieldset className="space-y-2" aria-describedby="category-kind-help">
        <legend className="text-sm font-medium">Kind</legend>
        <RadioGroup name="kind" defaultValue="expense" required={!locked} disabled={locked} aria-label="Kind" className="grid-cols-3">
          {categoryKinds.map((kind) => (
            <RadioPill key={kind} value={kind}>
              {categoryKindLabel(kind)}
            </RadioPill>
          ))}
        </RadioGroup>
      </fieldset>
      <p id="category-kind-help" className="text-sm text-muted-foreground">
        {TRANSFER_KIND_HELP}
      </p>
    </div>
  );
}

export function CategoryForm({ groups }: { groups: Array<{ id: string; name: string }> }) {
  const [state, action, pending] = useActionState(createCategoryAction, { error: "" });
  useActionToast(state, "Category added.");
  if (groups.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">Add a group first. Each category belongs to one.</p>
        <KindChoices locked />
      </div>
    );
  }
  return (
    <form action={action} className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="category-name">Category name</Label>
          <Input id="category-name" name="name" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="category-group">Group</Label>
          <Select id="category-group" name="groupId" required defaultValue={groups[0]?.id}>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <KindChoices />
      <Button type="submit" className="w-full sm:w-auto" disabled={pending}>
        Add category
      </Button>
      {state.error ? (
        <FieldError>
          {state.error}
        </FieldError>
      ) : null}
    </form>
  );
}
