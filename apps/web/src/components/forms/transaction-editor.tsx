"use client";

import { FieldError } from "@/components/ui/field";
import { type CategoryMenuEntry, type TransactionDirection } from "@dollas/domain";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteTransactionAction, separateBankMatchAction, updateTransactionAction } from "@/slices/activity/actions";
import { RecurringLinkControl } from "@/components/recurring/recurring-forms";
import { SplitControl, type SplitRow } from "./split-control";
import { useActionToast } from "@/lib/use-action-toast";
import { toast } from "@/lib/toast-store";
import { Select } from "@/components/ui/select";

type Option = { id: string; name: string; archived?: boolean };

function unsignedDollarInput(cents: number): string {
  const absolute = Math.abs(cents);
  const dollars = Math.trunc(absolute / 100);
  const remainder = String(absolute % 100).padStart(2, "0");
  return `${dollars}.${remainder}`;
}

export function TransactionEditor({
  transaction,
  accounts,
  categories,
  recurringChoices = [],
  onDeleted,
}: {
  transaction: {
    id: string;
    payee: string;
    occurredOn: string;
    amountCents: number;
    accountId: string;
    bankMatched?: boolean;
    recurring?: { id: string; name: string } | null;
    splits: Array<{ categoryId: string; amountCents: number }>;
  };
  accounts: Option[];
  categories: CategoryMenuEntry[];
  recurringChoices?: Array<{ id: string; name: string }>;
  onDeleted: (transaction: { id: string; payee: string }) => void;
}) {
  const field = `edit-${transaction.id}`;
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(updateTransactionAction, { error: "" });
  useActionToast(state, "Transaction saved.");
  const [payee, setPayee] = useState(transaction.payee);
  const [occurredOn, setOccurredOn] = useState(transaction.occurredOn);
  const [accountId, setAccountId] = useState(transaction.accountId);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [separating, setSeparating] = useState(false);
  const direction: TransactionDirection = transaction.amountCents > 0 ? "income" : "expense";
  const initialRows: SplitRow[] = (
    transaction.splits.length > 0
      ? transaction.splits
      : [{ categoryId: categories[0]?.id ?? "", amountCents: transaction.amountCents }]
  ).map((part, index) => ({
    key: `${part.categoryId}-${index}`,
    categoryId: part.categoryId,
    amount: unsignedDollarInput(part.amountCents),
  }));

  async function onDelete() {
    setRemoving(true);
    setRemoveError("");
    const result = await deleteTransactionAction(transaction.id);
    setRemoving(false);
    if (result.error) {
      setRemoveError(result.error);
      return;
    }
    onDeleted({ id: transaction.id, payee: transaction.payee });
  }

  async function onSeparate() {
    setSeparating(true);
    setRemoveError("");
    const result = await separateBankMatchAction(transaction.id);
    setSeparating(false);
    if (result.error) setRemoveError(result.error);
    else toast("Split into two transactions: yours and the bank's.");
  }

  return (
    <div className="mt-3 space-y-3 border-t-2 border-dashed border-border-soft pt-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          type="button"
          variant="link"
          className="h-11 px-0"
          aria-expanded={open}
          aria-controls={`${field}-panel`}
          aria-label={`Edit ${transaction.payee}`}
          onClick={() => setOpen((value) => !value)}
        >
          Edit
        </Button>
        <div className="flex flex-wrap items-center gap-2">
        {transaction.bankMatched ? (
          <Button
            type="button"
            variant="outline"
           
            disabled={separating}
            aria-label={`Not the same charge as the bank's: separate ${transaction.payee}`}
            title="Bank sync matched this to your entry. If they are two different charges, keep both."
            onClick={() => void onSeparate()}
          >
            {separating ? "Separating" : "Not the same charge"}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="destructive"
         
          disabled={removing}
          aria-label={`Delete ${transaction.payee}`}
          onClick={() => void onDelete()}
        >
          {removing ? "Deleting" : "Delete"}
        </Button>
        </div>
      </div>
      {removeError ? (
        <FieldError>
          {removeError}
        </FieldError>
      ) : null}
      {open ? (
        <form id={`${field}-panel`} action={action} className="space-y-3">
          <input type="hidden" name="transactionId" value={transaction.id} />
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`${field}-payee`}>Payee</Label>
              <Input
                id={`${field}-payee`}
                name="payee"
               
                value={payee}
                onChange={(event) => setPayee(event.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${field}-date`}>Date</Label>
              <Input
                id={`${field}-date`}
                name="occurredOn"
               
                type="date"
                value={occurredOn}
                onChange={(event) => setOccurredOn(event.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor={`${field}-account`}>Account</Label>
              <Select
                id={`${field}-account`}
                name="accountId"
               
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                required
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.archived ? `${account.name} (archived)` : account.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <SplitControl
            fieldId={field}
            categories={categories}
            initialDirection={direction}
            initialRows={initialRows}
            initialSplit={transaction.splits.length > 1}
          />
          {state.error ? (
            <FieldError>
              {state.error}
            </FieldError>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? "Saving" : "Save"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {open ? (
        <RecurringLinkControl
          transactionId={transaction.id}
          payee={transaction.payee}
          recurring={transaction.recurring ?? null}
          choices={recurringChoices}
        />
      ) : null}
    </div>
  );
}
