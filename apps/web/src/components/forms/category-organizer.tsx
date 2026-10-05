"use client";

import { categoryKindLabel, isCategoryKind } from "@dollas/domain";
import { useActionState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  moveCategoryAction,
  removeCategoryGroupAction,
  renameCategoryGroupAction,
  shiftCategoryAction,
  shiftCategoryGroupAction,
} from "@/slices/categories/actions";

const selectClass = "h-10 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm sm:w-44";

type ActionState = { error: string };

type OrganizerAction = (state: ActionState, formData: FormData) => Promise<ActionState>;

type ListedCategory = { id: string; name: string; kind: string };

type ListedGroup = { id: string; name: string; categories: ListedCategory[] };

type Destination = { value: string; label: string };

function kindLabel(kind: string): string {
  return isCategoryKind(kind) ? categoryKindLabel(kind) : kind;
}

function FormError({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="basis-full text-sm text-over">
      {message}
    </p>
  );
}

function ShiftButton({
  action,
  field,
  direction,
  label,
  disabled,
}: {
  action: OrganizerAction;
  field: { name: string; value: string };
  direction: "up" | "down";
  label: string;
  disabled: boolean;
}) {
  const [state, formAction, pending] = useActionState(action, { error: "" });
  const text = direction === "up" ? "Up" : "Down";
  return (
    <form action={formAction} aria-busy={pending}>
      <input type="hidden" name={field.name} value={field.value} />
      <input type="hidden" name="direction" value={direction} />
      <Button
        type="submit"
        variant="outline"
        className="h-10 min-w-16"
        disabled={disabled || pending}
        aria-label={`Move ${label} ${direction}`}
      >
        {text}
      </Button>
      <FormError message={state.error} />
    </form>
  );
}

function ShiftControls({
  action,
  field,
  label,
  index,
  count,
}: {
  action: OrganizerAction;
  field: { name: string; value: string };
  label: string;
  index: number;
  count: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ShiftButton action={action} field={field} direction="up" label={label} disabled={index === 0} />
      <ShiftButton action={action} field={field} direction="down" label={label} disabled={index === count - 1} />
    </div>
  );
}

function RenameGroupForm({ group }: { group: ListedGroup }) {
  const [state, action, pending] = useActionState(renameCategoryGroupAction, { error: "" });
  const inputId = `group-name-${group.id}`;
  return (
    <form action={action} aria-busy={pending} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="groupId" value={group.id} />
      <div className="w-full space-y-1.5 sm:max-w-xs">
        <Label htmlFor={inputId}>Name</Label>
        <Input
          key={group.name}
          id={inputId}
          name="name"
          defaultValue={group.name}
          required
          autoComplete="off"
          className="h-10"
        />
      </div>
      <Button type="submit" variant="secondary" className="h-10" disabled={pending}>
        Rename
      </Button>
      <FormError message={state.error} />
    </form>
  );
}

function RemoveEmptyGroup({ group }: { group: ListedGroup }) {
  const [state, action, pending] = useActionState(removeCategoryGroupAction, { error: "" });
  return (
    <form action={action} aria-busy={pending}>
      <input type="hidden" name="groupId" value={group.id} />
      <Button type="submit" variant="destructive" className="h-10" disabled={pending}>
        Remove group
      </Button>
      <FormError message={state.error} />
    </form>
  );
}

function RemoveGroupForm({ group, destinations }: { group: ListedGroup; destinations: Destination[] }) {
  const [state, action, pending] = useActionState(removeCategoryGroupAction, { error: "" });
  const selectId = `remove-${group.id}`;
  return (
    <form action={action} aria-busy={pending} className="space-y-2">
      <input type="hidden" name="groupId" value={group.id} />
      <div className="space-y-1.5">
        <Label htmlFor={selectId}>Where should these categories go?</Label>
        <select id={selectId} name="destination" className={selectClass} required defaultValue="">
          <option value="" disabled>
            Choose a place
          </option>
          {destinations.map((destination) => (
            <option key={destination.value} value={destination.value}>
              {destination.label}
            </option>
          ))}
          <option value="ungrouped">Ungrouped</option>
        </select>
      </div>
      <Button type="submit" variant="destructive" className="h-10" disabled={pending}>
        Remove group
      </Button>
      <FormError message={state.error} />
    </form>
  );
}

function MoveCategoryForm({ category, destinations }: { category: ListedCategory; destinations: Destination[] }) {
  const [state, action, pending] = useActionState(moveCategoryAction, { error: "" });
  const selectId = `move-${category.id}`;
  return (
    <form action={action} aria-busy={pending} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="categoryId" value={category.id} />
      <div className="w-full space-y-1.5 sm:w-44">
        <Label htmlFor={selectId}>Move to</Label>
        <select id={selectId} name="destination" className={selectClass} required defaultValue="">
          <option value="" disabled>
            Choose a place
          </option>
          {destinations.map((destination) => (
            <option key={destination.value} value={destination.value}>
              {destination.label}
            </option>
          ))}
        </select>
      </div>
      <Button type="submit" variant="outline" className="h-10" disabled={pending}>
        Move
      </Button>
      <FormError message={state.error} />
    </form>
  );
}

function destinationsFor(groupId: string | null, groups: ListedGroup[]): Destination[] {
  return [
    ...groups.filter((group) => group.id !== groupId).map((group) => ({ value: group.id, label: group.name })),
    ...(groupId ? [{ value: "ungrouped", label: "Ungrouped" }] : []),
  ];
}

function CategoryRow({
  category,
  groupId,
  groups,
  index,
  count,
}: {
  category: ListedCategory;
  groupId: string | null;
  groups: ListedGroup[];
  index: number;
  count: number;
}) {
  const destinations = destinationsFor(groupId, groups);
  return (
    <li className="flex flex-col gap-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium">{category.name}</span>
        <Badge variant="secondary" className="shrink-0">
          {kindLabel(category.kind)}
        </Badge>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
        {destinations.length > 0 ? <MoveCategoryForm category={category} destinations={destinations} /> : null}
        <ShiftControls
          action={shiftCategoryAction}
          field={{ name: "categoryId", value: category.id }}
          label={category.name}
          index={index}
          count={count}
        />
      </div>
    </li>
  );
}

function GroupCard({ group, groups, index }: { group: ListedGroup; groups: ListedGroup[]; index: number }) {
  const otherGroups = groups.filter((item) => item.id !== group.id);
  return (
    <li>
      <Card>
        <CardHeader>
          <h2 className="font-serif text-2xl leading-none">{group.name}</h2>
          {group.categories.length === 0 ? <CardDescription>No categories in this group yet.</CardDescription> : null}
        </CardHeader>
        <CardContent className="space-y-4">
          <RenameGroupForm group={group} />
          <div className="flex flex-wrap items-center gap-2">
            <ShiftControls
              action={shiftCategoryGroupAction}
              field={{ name: "groupId", value: group.id }}
              label={group.name}
              index={index}
              count={groups.length}
            />
            {group.categories.length === 0 ? <RemoveEmptyGroup group={group} /> : null}
          </div>
          {group.categories.length > 0 ? (
            <ol className="m-0 list-none divide-y divide-border border-t border-border p-0">
              {group.categories.map((category, categoryIndex) => (
                <CategoryRow
                  key={category.id}
                  category={category}
                  groupId={group.id}
                  groups={groups}
                  index={categoryIndex}
                  count={group.categories.length}
                />
              ))}
            </ol>
          ) : null}
          {group.categories.length > 0 ? (
            <RemoveGroupForm
              group={group}
              destinations={otherGroups.map((item) => ({ value: item.id, label: item.name }))}
            />
          ) : null}
        </CardContent>
      </Card>
    </li>
  );
}

export function CategoryOrganizer({ groups, ungrouped }: { groups: ListedGroup[]; ungrouped: ListedCategory[] }) {
  return (
    <div className="space-y-3">
      {groups.length > 0 ? (
        <ol className="m-0 list-none space-y-3 p-0">
          {groups.map((group, index) => (
            <GroupCard key={group.id} group={group} groups={groups} index={index} />
          ))}
        </ol>
      ) : null}
      {ungrouped.length > 0 ? (
        <Card>
          <CardHeader>
            <h2 className="font-serif text-2xl leading-none">Ungrouped</h2>
            <CardDescription>
              {groups.length === 0
                ? "Add a group, then move a category into it."
                : "These categories are not in a group."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="m-0 list-none divide-y divide-border p-0">
              {ungrouped.map((category, index) => (
                <CategoryRow
                  key={category.id}
                  category={category}
                  groupId={null}
                  groups={groups}
                  index={index}
                  count={ungrouped.length}
                />
              ))}
            </ol>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
