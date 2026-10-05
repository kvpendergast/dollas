"use client";

import { categoryKindLabel, categoryKinds } from "@dollas/domain";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createCategoryAction, createCategoryGroupAction } from "@/slices/categories/actions";

const selectClass = "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm";

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

export function CategoryForm({ groups }: { groups: Array<{ id: string; name: string }> }) {
  const [state, action, pending] = useActionState(createCategoryAction, { error: "" });
  if (groups.length === 0) {
    return <p className="text-sm text-muted-foreground">Add a group first. Each category belongs to one.</p>;
  }
  return (
    <form action={action} className="grid gap-3 md:grid-cols-[1fr_12rem_10rem_auto] md:items-end">
      <div className="space-y-1.5">
        <Label htmlFor="category-name">Category name</Label>
        <Input id="category-name" name="name" required />
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
      <div className="space-y-1.5">
        <Label htmlFor="category-kind">Kind</Label>
        <select id="category-kind" name="kind" className={selectClass} required defaultValue="expense">
          {categoryKinds.map((kind) => (
            <option key={kind} value={kind}>
              {categoryKindLabel(kind)}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" className="h-8" disabled={pending}>
        Add category
      </Button>
      {state.error ? (
        <p role="alert" className="text-sm text-over md:col-span-4">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
