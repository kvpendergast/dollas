"use client";

import { FieldError } from "@/components/ui/field";
import { NOTE_MAX_LENGTH, SPLIT_GROUP_COPY, TRANSFER_PAIR_COPY, type CategoryMenuEntry, type TransactionDirection } from "@dollas/domain";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteTransactionAction, separateBankMatchAction, updateTransactionAction } from "@/slices/activity/actions";
import { RecurringLinkControl } from "@/components/recurring/recurring-forms";
import { SplitControl, type SplitRow } from "./split-control";
import { SplitEditor } from "./split-editor";
import { unlinkTransferAction, unsplitAction } from "@/slices/splits/actions";
import type { ListedSplit } from "@/slices/activity/transactions";
import { useActionToast } from "@/lib/use-action-toast";
import { toast } from "@/lib/toast-store";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type Option = { id: string; name: string; archived?: boolean };

/** "17.94" for -1794 or 1794: the field is unsigned; the Direction select carries the sign. */
export function unsignedDollarInput(cents: number): string {
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
  initialOpen = false,
}: {
  transaction: {
    id: string;
    payee: string;
    occurredOn: string;
    amountCents: number;
    accountId: string;
    note?: string | null;
    bankMatched?: boolean;
    recurring?: { id: string; name: string } | null;
    splits: Array<{ categoryId: string; amountCents: number }>;
    splitGroup?: ListedSplit | null;
    /** Set when this deposit is a paycheck's linked net pay (PEN-349). */
    linkedTo?: { lineId: string; parentId: string; parentPayee: string } | null;
  };
  accounts: Option[];
  categories: CategoryMenuEntry[];
  recurringChoices?: Array<{ id: string; name: string }>;
  onDeleted: (transaction: { id: string; payee: string }) => void;
  initialOpen?: boolean;
}) {
  const field = `edit-${transaction.id}`;
  const [open, setOpen] = useState(initialOpen);
  const [state, action, pending] = useActionState(updateTransactionAction, { error: "" });
  useActionToast(state, "Transaction saved.");
  const [payee, setPayee] = useState(transaction.payee);
  const [occurredOn, setOccurredOn] = useState(transaction.occurredOn);
  const [accountId, setAccountId] = useState(transaction.accountId);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const [separating, setSeparating] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const [unsplitting, setUnsplitting] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const group = transaction.splitGroup ?? null;
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

  async function onUnsplit() {
    if (!window.confirm(`Unsplit ${transaction.payee}? Its lines are removed and it counts on its own again.`)) return;
    setUnsplitting(true);
    setRemoveError("");
    const result = await unsplitAction(transaction.id);
    setUnsplitting(false);
    if (result.error) setRemoveError(result.error);
    else toast(`Unsplit ${transaction.payee}.`);
  }

  async function onUnlink() {
    setUnlinking(true);
    setRemoveError("");
    const result = await unlinkTransferAction(transaction.id);
    setUnlinking(false);
    if (result.error) setRemoveError(result.error);
    else toast(`Unlinked ${transaction.payee}; it has its old category back.`);
  }

  // A deposit linked to a paycheck's net pay: unlink it before changing it.
  if (transaction.linkedTo && !group) {
    return (
      <div className="mt-3 space-y-2 border-t-2 border-dashed border-border-soft pt-2" data-transfer-linked>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">{TRANSFER_PAIR_COPY.depositLocked}</p>
          <Button type="button" variant="outline" disabled={unlinking} aria-label={`${TRANSFER_PAIR_COPY.unlink}: ${transaction.payee}`} onClick={() => void onUnlink()}>
            {unlinking ? "Unlinking" : TRANSFER_PAIR_COPY.unlink}
          </Button>
        </div>
        {removeError ? <FieldError>{removeError}</FieldError> : null}
      </div>
    );
  }

  // A line or deposit of a split is changed from its parent.
  if (group && group.role !== "parent") {
    return (
      <p className="mt-2 text-xs text-muted-foreground" data-split-locked>
        {SPLIT_GROUP_COPY.locked}
      </p>
    );
  }

  if (group?.role === "parent") {
    return (
      <div className="mt-3 space-y-3 border-t-2 border-dashed border-border-soft pt-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button
            type="button"
            variant="link"
            className="h-11 px-0"
            aria-expanded={splitting}
            aria-controls={`split-${transaction.id}-panel`}
            aria-label={`${SPLIT_GROUP_COPY.edit}: ${transaction.payee}`}
            onClick={() => setSplitting((value) => !value)}
          >
            {SPLIT_GROUP_COPY.edit}
          </Button>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" disabled={unsplitting} aria-label={`${SPLIT_GROUP_COPY.unsplit} ${transaction.payee}`} onClick={() => void onUnsplit()}>
              {unsplitting ? "Unsplitting" : SPLIT_GROUP_COPY.unsplit}
            </Button>
            <Button type="button" variant="destructive" disabled={removing} aria-label={`Delete ${transaction.payee}`} onClick={() => void onDelete()}>
              {removing ? "Deleting" : "Delete"}
            </Button>
          </div>
        </div>
        {removeError ? <FieldError>{removeError}</FieldError> : null}
        {splitting ? (
          <SplitEditor
            transaction={transaction}
            parentCategoryIds={transaction.splits.map((part) => part.categoryId)}
            lines={group.view.lines.map((line) => ({
              payee: line.payee,
              categoryId: line.categoryId ?? "",
              amountCents: line.amountCents,
              reimbursed: line.reimbursed,
              deposit: line.deposit ? { accountId: line.deposit.accountId } : null,
              linked: line.linked,
            }))}
            categories={categories}
            accounts={accounts.filter((account) => !account.archived)}
            onClose={() => setSplitting(false)}
          />
        ) : null}
      </div>
    );
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
          onClick={() => {
            setOpen((value) => !value);
            setSplitting(false);
          }}
        >
          Edit
        </Button>
        <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          aria-expanded={splitting}
          aria-controls={`split-${transaction.id}-panel`}
          aria-label={`${SPLIT_GROUP_COPY.action}: ${transaction.payee}`}
          onClick={() => {
            setSplitting((value) => !value);
            setOpen(false);
          }}
        >
          {SPLIT_GROUP_COPY.action}
        </Button>
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
      {splitting ? (
        <SplitEditor
          transaction={transaction}
          parentCategoryIds={transaction.splits.map((part) => part.categoryId)}
          categories={categories}
          accounts={accounts.filter((account) => !account.archived)}
          onClose={() => setSplitting(false)}
        />
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
            <div className="space-y-1.5">
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
            <div className="space-y-1.5">
              <Label htmlFor={`${field}-amount`}>Amount</Label>
              <Input
                id={`${field}-amount`}
                name="amount"
                inputMode="decimal"
                placeholder="0.00"
                defaultValue={unsignedDollarInput(transaction.amountCents)}
                required
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${field}-note`}>Note (optional)</Label>
            <Textarea id={`${field}-note`} name="note" rows={2} maxLength={NOTE_MAX_LENGTH} defaultValue={transaction.note ?? ""} />
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
