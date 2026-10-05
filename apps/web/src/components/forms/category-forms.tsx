"use client";

import { TRANSFER_KIND_HELP, categoryKindLabel, categoryKinds } from "@dollas/domain";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createCategoryAction, createCategoryGroupAction } from "@/slices/categories/actions";

const selectClass = "h-10 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm";

export function CategoryGroupForm() {
  const [state, action, pending] = useActionState(createCategoryGroupAction, { error: "" });
  return (
    <form action={action} className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
      <div className="space-y-1.5">
        <Label htmlFor="group-name">Group name</Label>
        <Input id="group-name" name="name" required />
      </div>
      <Button type="submit" className="h-8" disabled={pending}>
        Add group
      </Button>
      {state.error ? (
        <p role="alert" className="text-sm text-over md:col-span-2">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

function KindChoices({ locked = false }: { locked?: boolean }) {
  return (
    <div className="space-y-2">
      <fieldset className="space-y-2" aria-describedby="category-kind-help">
        <legend className="text-sm font-medium">Kind</legend>
        <div className="grid grid-cols-3 gap-2">
          {categoryKinds.map((kind) => (
            <label key={kind} className={locked ? "" : "cursor-pointer"}>
              <input
                type="radio"
                name="kind"
                value={kind}
                defaultChecked={kind === "expense"}
                required={!locked}
                disabled={locked}
                className="peer sr-only"
              />
              <span className="flex h-10 items-center justify-center rounded-lg border border-input bg-background px-2 text-sm peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50 peer-disabled:opacity-100">
                {categoryKindLabel(kind)}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <p id="category-kind-help" className="text-sm text-muted-foreground">
        {TRANSFER_KIND_HELP}
      </p>
    </div>
  );
}

export function CategoryForm({ groups }: { groups: Array<{ id: string; name: string }> }) {
  const [state, action, pending] = useActionState(createCategoryAction, { error: "" });
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
          <Input id="category-name" name="name" required className="h-10" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="category-group">Group</Label>
          <select id="category-group" name="groupId" className={selectClass} required defaultValue={groups[0]?.id}>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <KindChoices />
      <Button type="submit" className="h-10 w-full sm:w-auto" disabled={pending}>
        Add category
      </Button>
      {state.error ? (
        <p role="alert" className="text-sm text-over">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
