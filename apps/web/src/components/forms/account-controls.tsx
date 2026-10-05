"use client";

import { CREDIT_OWED_HINT, DELETE_BLOCKED_MESSAGE, openingBalanceFields, type AccountType } from "@dollas/domain";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  archiveAccountAction,
  deleteAccountAction,
  unarchiveAccountAction,
  updateAccountAction,
} from "@/slices/accounts/actions";

export function AccountControls({
  account,
}: {
  account: {
    id: string;
    name: string;
    type: AccountType;
    openingBalanceCents: number;
    transactionCount: number;
    archived: boolean;
  };
}) {
  const fields = openingBalanceFields(account);
  const amount = fields.isOk() ? fields.value.amount : "0.00";
  const owedAtStart = fields.isOk() ? fields.value.owed : account.type === "credit";
  const [name, setName] = useState(account.name);
  const [opening, setOpening] = useState(amount);
  const [owed, setOwed] = useState(owedAtStart);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saved, save, saving] = useActionState(updateAccountAction, { error: "" });
  const [archivedState, archive, archiving] = useActionState(archiveAccountAction, { error: "" });
  const [restored, unarchive, unarchiving] = useActionState(unarchiveAccountAction, { error: "" });
  const [removed, remove, removing] = useActionState(deleteAccountAction, { error: "" });
  const credit = account.type === "credit";
  const blocked = account.transactionCount > 0;
  const field = `account-${account.id}`;

  return (
    <div className="space-y-3">
      <details className="rounded-lg border border-border px-3 py-2">
        <summary className="cursor-pointer text-sm text-primary" aria-label={`Edit ${account.name}`}>
          Edit name and opening balance
        </summary>
        <form action={save} className="mt-3 space-y-3">
          <input type="hidden" name="accountId" value={account.id} />
          <div className="space-y-1.5">
            <Label htmlFor={`${field}-name`}>Name</Label>
            <Input id={`${field}-name`} name="name" className="h-10" value={name} onChange={(event) => setName(event.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${field}-opening`}>{credit && owed ? "Amount owed" : "Opening balance"}</Label>
            <Input
              id={`${field}-opening`}
              name="opening"
              className="h-10"
              inputMode="decimal"
              value={opening}
              onChange={(event) => setOpening(event.target.value)}
              required
            />
          </div>
          {credit ? (
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                name="owed"
                value="yes"
                className="mt-1 size-4 accent-primary"
                checked={owed}
                onChange={(event) => setOwed(event.target.checked)}
              />
              <span>
                <span className="font-medium">Owed</span>
                <span className="mt-1 block text-muted-foreground">{CREDIT_OWED_HINT}</span>
              </span>
            </label>
          ) : null}
          {saved.error ? (
            <p role="alert" className="text-sm text-over">
              {saved.error}
            </p>
          ) : null}
          <Button type="submit" className="h-10" disabled={saving}>
            {saving ? "Saving" : "Save"}
          </Button>
        </form>
      </details>

      {blocked ? <p className="text-sm text-muted-foreground">{DELETE_BLOCKED_MESSAGE}</p> : null}

      {account.archived ? (
        <form action={unarchive}>
          <input type="hidden" name="accountId" value={account.id} />
          <Button type="submit" variant="outline" className="h-10" disabled={unarchiving} aria-label={`Unarchive ${account.name}`}>
            {unarchiving ? "Unarchiving" : "Unarchive"}
          </Button>
          {restored.error ? (
            <p role="alert" className="mt-2 text-sm text-over">
              {restored.error}
            </p>
          ) : null}
        </form>
      ) : (
        <form action={archive}>
          <input type="hidden" name="accountId" value={account.id} />
          <Button type="submit" variant="outline" className="h-10" disabled={archiving} aria-label={`Archive ${account.name}`}>
            {archiving ? "Archiving" : "Archive"}
          </Button>
          {archivedState.error ? (
            <p role="alert" className="mt-2 text-sm text-over">
              {archivedState.error}
            </p>
          ) : null}
        </form>
      )}

      {blocked ? null : confirmingDelete ? (
        <div role="alertdialog" aria-labelledby={`${field}-delete-title`} className="space-y-3 rounded-lg bg-muted px-3 py-3">
          <div>
            <p id={`${field}-delete-title`} className="font-medium">
              Delete {account.name}?
            </p>
            <p className="text-sm text-muted-foreground">This cannot be undone.</p>
          </div>
          <form action={remove} className="flex flex-wrap gap-2">
            <input type="hidden" name="accountId" value={account.id} />
            <input type="hidden" name="confirm" value="yes" />
            <Button type="submit" variant="destructive" className="h-10" disabled={removing}>
              {removing ? "Deleting" : "Delete account"}
            </Button>
            <Button type="button" variant="outline" className="h-10" onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
          </form>
          {removed.error ? (
            <p role="alert" className="text-sm text-over">
              {removed.error}
            </p>
          ) : null}
        </div>
      ) : (
        <Button
          type="button"
          variant="destructive"
          className="h-10"
          aria-label={`Delete ${account.name}`}
          onClick={() => setConfirmingDelete(true)}
        >
          Delete
        </Button>
      )}
    </div>
  );
}
