"use client";

import { type CategoryMenuEntry, type TransactionDirection } from "@dollas/domain";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteTransactionAction, separateBankMatchAction, updateTransactionAction } from "@/slices/activity/actions";
import { SplitControl, type SplitRow } from "./split-control";

type Option = { id: string; name: string; archived?: boolean };

const selectClass = "h-10 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm";

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
  onDeleted,
}: {
  transaction: {
    id: string;
    payee: string;
    occurredOn: string;
    amountCents: number;
    accountId: string;
    bankMatched?: boolean;
    splits: Array<{ categoryId: string; amountCents: number }>;
  };
  accounts: Option[];
  categories: CategoryMenuEntry[];
  onDeleted: (transaction: { id: string; payee: string }) => void;
}) {
  const field = `edit-${transaction.id}`;
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(updateTransactionAction, { error: "" });
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
  }

  return (
    <div className="mt-3 space-y-3 border-t border-border pt-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          className="inline-flex h-10 items-center text-sm text-primary"
          aria-expanded={open}
          aria-controls={`${field}-panel`}
          aria-label={`Edit ${transaction.payee}`}
          onClick={() => setOpen((value) => !value)}
        >
          Edit
        </button>
        <div className="flex flex-wrap items-center gap-2">
        {transaction.bankMatched ? (
          <Button
            type="button"
            variant="outline"
            className="h-10"
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
          className="h-10"
          disabled={removing}
          aria-label={`Delete ${transaction.payee}`}
          onClick={() => void onDelete()}
        >
          {removing ? "Deleting" : "Delete"}
        </Button>
        </div>
      </div>
      {removeError ? (
        <p role="alert" className="text-sm text-over">
          {removeError}
        </p>
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
                className="h-10"
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
                className="h-10"
                type="date"
                value={occurredOn}
                onChange={(event) => setOccurredOn(event.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor={`${field}-account`}>Account</Label>
              <select
                id={`${field}-account`}
                name="accountId"
                className={selectClass}
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                required
              >
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.archived ? `${account.name} (archived)` : account.name}
                  </option>
                ))}
              </select>
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
            <p role="alert" className="text-sm text-over">
              {state.error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" className="h-10" disabled={pending}>
              {pending ? "Saving" : "Save"}
            </Button>
            <Button type="button" variant="ghost" className="h-10" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
