"use client";

import { filterHref, filterToSearchParams, type SpendingFilter } from "@dollas/domain";
import Link from "next/link";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { deleteSavedFilterAction, renameSavedFilterAction, saveFilterAction, type SavedFilterFormState } from "@/slices/spending/actions";
import type { FilterContext } from "@/slices/spending/load";

const EMPTY: SavedFilterFormState = { error: "", message: "" };

function Status({ state }: { state: SavedFilterFormState }) {
  if (state.error) return <p className="text-xs text-over" role="alert">{state.error}</p>;
  if (state.message) return <p className="text-xs text-income" role="status">{state.message}</p>;
  return null;
}

function sameFilter(a: SpendingFilter, b: SpendingFilter): boolean {
  return filterToSearchParams(a, "all").toString() === filterToSearchParams(b, "all").toString();
}

function SavedRow({ id, name, href, createdBy }: { id: string; name: string; href: string; createdBy: string | null }) {
  const [renameState, renameAction, renaming] = useActionState(renameSavedFilterAction, EMPTY);
  const [deleteState, deleteAction, deleting] = useActionState(deleteSavedFilterAction, EMPTY);
  const [editing, setEditing] = useState(false);
  return (
    <li className="space-y-1 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <Link href={href} className="font-medium text-primary underline-offset-4 hover:underline">
            {name}
          </Link>
          {createdBy ? <span className="ml-2 text-xs text-muted-foreground">saved by {createdBy}</span> : null}
        </div>
        <div className="flex gap-1">
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing((value) => !value)}>
            Rename
          </Button>
          <Dialog>
            <DialogTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="text-over">
                Delete
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete “{name}”?</DialogTitle>
                <DialogDescription>It goes for everyone in the household. Transactions are not touched.</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="outline">
                    Keep it
                  </Button>
                </DialogClose>
                <form action={deleteAction}>
                  <input type="hidden" name="id" value={id} />
                  <Button type="submit" variant="destructive" disabled={deleting}>
                    Delete
                  </Button>
                </form>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
      {editing ? (
        <form action={renameAction} className="flex gap-2">
          <input type="hidden" name="id" value={id} />
          <Input name="name" defaultValue={name} maxLength={60} aria-label={`New name for ${name}`} className="h-8" />
          <Button type="submit" size="sm" disabled={renaming}>
            Save
          </Button>
        </form>
      ) : null}
      <Status state={renameState} />
      <Status state={deleteState} />
    </li>
  );
}

/** The household's saved filters: apply one here, save the current filter, rename, or delete. */
export function SavedFilters({ path, anchor = "", ctx }: { path: string; anchor?: string; ctx: FilterContext }) {
  const [saveState, saveAction, saving] = useActionState(saveFilterAction, EMPTY);
  const current = ctx.saved.find((row) => sameFilter(row.filter, ctx.filter));
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {ctx.saved.length > 0 ? (
        <nav aria-label="Saved filters" className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">Saved:</span>
          {ctx.saved.map((row) => (
            <Link
              key={row.id}
              href={filterHref(path, row.filter, ctx.defaultRange) + anchor}
              aria-current={current?.id === row.id ? "true" : undefined}
              className="rounded-full border border-border px-3 py-1 text-xs hover:bg-muted aria-[current=true]:border-primary aria-[current=true]:bg-primary aria-[current=true]:text-primary-foreground"
            >
              {row.name}
            </Link>
          ))}
        </nav>
      ) : null}
      <details className="w-full">
        <summary className="w-fit cursor-pointer list-none py-1 text-xs font-medium text-primary hover:underline">
          {current ? `Manage saved filters` : "Save this filter"}
        </summary>
        <div className="mt-2 max-w-md space-y-3 rounded-lg border border-border bg-card p-3 shadow-sm">
          {!current ? (
            <form action={saveAction} className="space-y-1">
              <input type="hidden" name="filter" value={JSON.stringify(ctx.filter)} />
              <label className="text-xs text-muted-foreground" htmlFor="saved-filter-name">
                Save the current search and filters for the whole household
              </label>
              <div className="flex gap-2">
                <Input id="saved-filter-name" name="name" placeholder="e.g. Groceries this month" maxLength={60} className="h-8" required />
                <Button type="submit" size="sm" disabled={saving}>
                  Save
                </Button>
              </div>
              <Status state={saveState} />
            </form>
          ) : (
            <p className="text-xs text-muted-foreground">This view is saved as “{current.name}”.</p>
          )}
          {ctx.saved.length > 0 ? (
            <ul className="divide-y divide-border">
              {ctx.saved.map((row) => (
                <SavedRow key={row.id} id={row.id} name={row.name} createdBy={row.createdBy} href={filterHref(path, row.filter, ctx.defaultRange) + anchor} />
              ))}
            </ul>
          ) : null}
        </div>
      </details>
    </div>
  );
}
