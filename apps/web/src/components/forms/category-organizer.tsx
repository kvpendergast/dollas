"use client";

import {
  TRANSFER_KIND_HELP,
  categoryKindChangeWarning,
  categoryKindLabel,
  categoryKinds,
} from "@dollas/domain";
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Pencil } from "lucide-react";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  changeCategoryKindAction,
  moveCategoryAction,
  removeCategoryGroupAction,
  renameCategoryGroupAction,
  shiftCategoryAction,
  shiftCategoryGroupAction,
} from "@/slices/categories/actions";
import { useActionToast } from "@/lib/use-action-toast";
import { selectClass as selectBase } from "@/components/ui/select";
import { cn } from "@/lib/utils";

const selectClass = cn(selectBase, "sm:w-44");

type ActionState = { error: string };

type OrganizerAction = (state: ActionState, formData: FormData) => Promise<ActionState>;

type ListedCategory = { id: string; name: string; kind: string; budgetCount: number };

type ListedGroup = { id: string; name: string; categories: ListedCategory[] };

type Destination = { value: string; label: string };

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
  useActionToast(state, "Order saved.");
  const text = direction === "up" ? "Up" : "Down";
  return (
    <form action={formAction} aria-busy={pending}>
      <input type="hidden" name={field.name} value={field.value} />
      <input type="hidden" name="direction" value={direction} />
      <Button
        type="submit"
        variant="outline"
        className="min-w-16"
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
  useActionToast(state, "Group renamed.");
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
         
        />
      </div>
      <Button type="submit" variant="secondary" disabled={pending}>
        Rename
      </Button>
      <FormError message={state.error} />
    </form>
  );
}

function RemoveEmptyGroup({ group }: { group: ListedGroup }) {
  const [state, action, pending] = useActionState(removeCategoryGroupAction, { error: "" });
  useActionToast(state, "Group removed.");
  return (
    <form action={action} aria-busy={pending}>
      <input type="hidden" name="groupId" value={group.id} />
      <Button type="submit" variant="destructive" disabled={pending}>
        Remove group
      </Button>
      <FormError message={state.error} />
    </form>
  );
}

function RemoveGroupForm({ group, destinations }: { group: ListedGroup; destinations: Destination[] }) {
  const [state, action, pending] = useActionState(removeCategoryGroupAction, { error: "" });
  useActionToast(state, "Group removed.");
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
      <Button type="submit" variant="destructive" disabled={pending}>
        Remove group
      </Button>
      <FormError message={state.error} />
    </form>
  );
}

function MoveCategoryForm({ category, destinations }: { category: ListedCategory; destinations: Destination[] }) {
  const [state, action, pending] = useActionState(moveCategoryAction, { error: "" });
  useActionToast(state, "Category moved.");
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
      <Button type="submit" variant="outline" disabled={pending}>
        Move
      </Button>
      <FormError message={state.error} />
    </form>
  );
}

function ChangeKindForm({ category }: { category: ListedCategory }) {
  const [state, action, pending] = useActionState(changeCategoryKindAction, { error: "" });
  useActionToast(state, "Category updated.");
  const [kind, setKind] = useState(category.kind);
  const selectId = `kind-${category.id}`;
  const helpId = `kind-help-${category.id}`;
  const confirmId = `kind-confirm-${category.id}`;
  const liveWarning = categoryKindChangeWarning({
    name: category.name,
    currentKind: category.kind,
    nextKind: kind,
    budgetCount: category.budgetCount,
  });
  const removalWarning = categoryKindChangeWarning({
    name: category.name,
    currentKind: category.kind,
    nextKind: kind,
    budgetCount: Math.max(category.budgetCount, 1),
  });
  const warning = liveWarning ?? (state.error === removalWarning ? state.error : null);
  const otherError = state.error && state.error !== warning ? state.error : "";
  return (
    <form action={action} aria-busy={pending} className="flex w-full flex-col gap-2">
      <input type="hidden" name="categoryId" value={category.id} />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="w-full space-y-1.5 sm:max-w-xs">
          <Label htmlFor={selectId}>Kind</Label>
          <select
            id={selectId}
            name="kind"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
            aria-describedby={kind === "transfer" ? helpId : undefined}
            className={selectClass}
          >
            {categoryKinds.map((option) => (
              <option key={option} value={option}>
                {categoryKindLabel(option)}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" disabled={pending || kind === category.kind}>
          Change kind
        </Button>
      </div>
      {kind === "transfer" ? (
        <p id={helpId} className="text-sm text-muted-foreground">
          {TRANSFER_KIND_HELP}
        </p>
      ) : null}
      {warning ? (
        <div className="space-y-2 rounded-sm bg-muted p-3">
          <p role="status" className="text-sm">
            {warning}
          </p>
          <label htmlFor={confirmId} className="flex min-h-10 items-center gap-3 text-sm">
            <input id={confirmId} type="checkbox" name="confirmBudgetRemoval" value="yes" required className="size-5" />
            <span>Remove its budgets</span>
          </label>
        </div>
      ) : null}
      <FormError message={otherError} />
    </form>
  );
}

function destinationsFor(groupId: string | null, groups: ListedGroup[]): Destination[] {
  return [
    ...groups.filter((group) => group.id !== groupId).map((group) => ({ value: group.id, label: group.name })),
    ...(groupId ? [{ value: "ungrouped", label: "Ungrouped" }] : []),
  ];
}

const kindIcons = { income: ArrowDownLeft, expense: ArrowUpRight, transfer: ArrowLeftRight } as const;

function KindTag({ kind }: { kind: string }) {
  const Icon = kindIcons[kind as keyof typeof kindIcons] ?? ArrowUpRight;
  return (
    <span className="inline-flex items-center gap-1 text-xs font-bold text-muted-foreground">
      <Icon aria-hidden="true" className="size-3.5" />
      {categoryKindLabel(kind as (typeof categoryKinds)[number])}
    </span>
  );
}

function EditCategoryDialog({
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
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" aria-label={`Edit ${category.name}`}>
          <Pencil aria-hidden="true" />
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{category.name}</DialogTitle>
          <DialogDescription>Change its kind, move it to another group, or change its order.</DialogDescription>
        </DialogHeader>
        <ChangeKindForm key={`${category.id}:${category.kind}:${category.budgetCount}`} category={category} />
        <div className="flex flex-col gap-3 border-t-2 border-dashed border-border-soft pt-3">
          {destinations.length > 0 ? <MoveCategoryForm category={category} destinations={destinations} /> : null}
          <ShiftControls
            action={shiftCategoryAction}
            field={{ name: "categoryId", value: category.id }}
            label={category.name}
            index={index}
            count={count}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
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
  return (
    <li className="flex min-h-14 items-center justify-between gap-3 py-2">
      <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="rounded-full border-2 border-foreground bg-white px-3 py-1 font-bold break-words">{category.name}</span>
        <KindTag kind={category.kind} />
      </span>
      <EditCategoryDialog category={category} groupId={groupId} groups={groups} index={index} count={count} />
    </li>
  );
}

function EditGroupDialog({
  group,
  groups,
  index,
}: {
  group: ListedGroup;
  groups: ListedGroup[];
  index: number;
}) {
  const otherGroups = groups.filter((item) => item.id !== group.id);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" aria-label={`Edit group ${group.name}`}>
          <Pencil aria-hidden="true" />
          Edit group
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{group.name}</DialogTitle>
          <DialogDescription>Rename the group, change its order, or remove it.</DialogDescription>
        </DialogHeader>
        <RenameGroupForm group={group} />
        <ShiftControls
          action={shiftCategoryGroupAction}
          field={{ name: "groupId", value: group.id }}
          label={group.name}
          index={index}
          count={groups.length}
        />
        <div className="border-t-2 border-dashed border-border-soft pt-3">
          {group.categories.length === 0 ? (
            <RemoveEmptyGroup group={group} />
          ) : (
            <RemoveGroupForm group={group} destinations={otherGroups.map((item) => ({ value: item.id, label: item.name }))} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GroupCard({ group, groups, index }: { group: ListedGroup; groups: ListedGroup[]; index: number }) {
  return (
    <li>
      <Card className="gap-0 py-0">
        <CardHeader className="border-b-2 border-foreground bg-secondary py-3 has-data-[slot=card-action]:grid-cols-[1fr_auto]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 className="font-heading text-2xl leading-none">{group.name}</h2>
              <CardDescription className="mt-1">
                {group.categories.length === 0
                  ? "No categories in this group yet."
                  : `${group.categories.length} ${group.categories.length === 1 ? "category" : "categories"}`}
              </CardDescription>
            </div>
            <EditGroupDialog group={group} groups={groups} index={index} />
          </div>
        </CardHeader>
        {group.categories.length > 0 ? (
          <CardContent className="py-2">
            <ol className="m-0 list-none divide-y-2 divide-dashed divide-border-soft p-0">
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
          </CardContent>
        ) : null}
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
        <Card className="gap-0 py-0">
          <CardHeader className="border-b-2 border-foreground bg-muted py-3">
            <h2 className="font-heading text-2xl leading-none">Ungrouped</h2>
            <CardDescription>
              {groups.length === 0
                ? "Add a group, then move a category into it."
                : "These categories are not in a group."}
            </CardDescription>
          </CardHeader>
          <CardContent className="py-2">
            <ol className="m-0 list-none divide-y-2 divide-dashed divide-border-soft p-0">
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
