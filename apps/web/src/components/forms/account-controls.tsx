"use client";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

import { FieldError } from "@/components/ui/field";
import { CREDIT_OWED_HINT, DELETE_BLOCKED_MESSAGE, openingBalanceFields, type AccountType } from "@dollas/domain";
import { useActionState, useState } from "react";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  archiveAccountAction,
  deleteAccountAction,
  unarchiveAccountAction,
  updateAccountAction,
} from "@/slices/accounts/actions";
import { useActionToast } from "@/lib/use-action-toast";

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
  const [saved, save, saving] = useActionState(updateAccountAction, { error: "" });
  useActionToast(saved, "Account saved.");
  const [archivedState, archive, archiving] = useActionState(archiveAccountAction, { error: "" });
  useActionToast(archivedState, "Account archived. Its history stays.");
  const [restored, unarchive, unarchiving] = useActionState(unarchiveAccountAction, { error: "" });
  useActionToast(restored, "Account restored.");
  const [removed, remove, removing] = useActionState(deleteAccountAction, { error: "" });
  useActionToast(removed, "Account deleted.");
  const credit = account.type === "credit";
  const blocked = account.transactionCount > 0;
  const field = `account-${account.id}`;

  return (
    <div className="space-y-3">
      <Collapsible className="rounded-sm border-2 border-foreground px-3 py-1">
        <CollapsibleTrigger className="text-primary" aria-label={`Edit ${account.name}`}>
          Edit name and opening balance
        </CollapsibleTrigger>
        <CollapsibleContent>
        <form action={save} className="mt-3 space-y-3">
          <input type="hidden" name="accountId" value={account.id} />
          <div className="space-y-1.5">
            <Label htmlFor={`${field}-name`}>Name</Label>
            <Input id={`${field}-name`} name="name" value={name} onChange={(event) => setName(event.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${field}-opening`}>{credit && owed ? "Amount owed" : "Opening balance"}</Label>
            <Input
              id={`${field}-opening`}
              name="opening"
             
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
            <FieldError>
              {saved.error}
            </FieldError>
          ) : null}
          <Button type="submit" disabled={saving}>
            {saving ? "Saving" : "Save"}
          </Button>
        </form>
        </CollapsibleContent>
      </Collapsible>

      {blocked ? <p className="text-sm text-muted-foreground">{DELETE_BLOCKED_MESSAGE}</p> : null}

      {account.archived ? (
        <form action={unarchive}>
          <input type="hidden" name="accountId" value={account.id} />
          <Button type="submit" variant="outline" disabled={unarchiving} aria-label={`Unarchive ${account.name}`}>
            {unarchiving ? "Unarchiving" : "Unarchive"}
          </Button>
          {restored.error ? (
            <FieldError className="mt-2">
              {restored.error}
            </FieldError>
          ) : null}
        </form>
      ) : (
        <form action={archive}>
          <input type="hidden" name="accountId" value={account.id} />
          <Button type="submit" variant="outline" disabled={archiving} aria-label={`Archive ${account.name}`}>
            {archiving ? "Archiving" : "Archive"}
          </Button>
          {archivedState.error ? (
            <FieldError className="mt-2">
              {archivedState.error}
            </FieldError>
          ) : null}
        </form>
      )}

      {blocked ? null : (
        <ConfirmDialog
          trigger={
            <Button type="button" variant="destructive" aria-label={`Delete ${account.name}`}>
              Delete
            </Button>
          }
          title={`Delete ${account.name}?`}
          description="This cannot be undone."
          action={remove}
          pending={removing}
          error={removed.error}
          confirmLabel="Delete account"
          pendingLabel="Deleting"
        >
          <input type="hidden" name="accountId" value={account.id} />
          <input type="hidden" name="confirm" value="yes" />
        </ConfirmDialog>
      )}
    </div>
  );
}
