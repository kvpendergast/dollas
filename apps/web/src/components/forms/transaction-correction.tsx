"use client";

import { categoryMenuSections, type CategoryMenuEntry } from "@dollas/domain";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateTransactionAction } from "@/slices/activity/actions";

type Option = { id: string; name: string };

type SplitRow = {
  key: string;
  categoryId: string;
  amount: string;
};

const selectClass = "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm";

function unsignedDollarInput(cents: number): string {
  const absolute = Math.abs(cents);
  const dollars = Math.trunc(absolute / 100);
  const remainder = String(absolute % 100).padStart(2, "0");
  return `${dollars}.${remainder}`;
}

function blankRow(existing: readonly SplitRow[], categories: readonly CategoryMenuEntry[]): SplitRow {
  const used = new Set(existing.map((row) => row.categoryId));
  const categoryId = categories.find((category) => !used.has(category.id))?.id ?? "";
  return { key: crypto.randomUUID(), categoryId, amount: "" };
}

export function TransactionCorrection({
  transaction,
  accounts,
  categories,
}: {
  transaction: {
    id: string;
    payee: string;
    occurredOn: string;
    amountCents: number;
    accountId: string;
    splits: Array<{ categoryId: string; amountCents: number }>;
  };
  accounts: Option[];
  categories: CategoryMenuEntry[];
}) {
  const field = `correction-${transaction.id}`;
  const [state, action, pending] = useActionState(updateTransactionAction, { error: "" });
  const [payee, setPayee] = useState(transaction.payee);
  const [occurredOn, setOccurredOn] = useState(transaction.occurredOn);
  const [accountId, setAccountId] = useState(transaction.accountId);
  const [direction, setDirection] = useState(transaction.amountCents > 0 ? "income" : "expense");
  const [amount, setAmount] = useState(unsignedDollarInput(transaction.amountCents));
  const [split, setSplit] = useState(transaction.splits.length > 1);
  const [rows, setRows] = useState<SplitRow[]>(() =>
    (transaction.splits.length > 0
      ? transaction.splits
      : [{ categoryId: categories[0]?.id ?? "", amountCents: transaction.amountCents }]
    ).map((part) => ({
      key: part.categoryId,
      categoryId: part.categoryId,
      amount: unsignedDollarInput(part.amountCents),
    })),
  );
  const visible = split ? rows : rows.slice(0, 1);
  const used = new Set(visible.map((row) => row.categoryId));
  const canAdd = split && categories.some((category) => !used.has(category.id));
  const canSplit = categories.length > 1;

  function updateRow(key: string, patch: Partial<Pick<SplitRow, "categoryId" | "amount">>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  return (
    <details className="mt-3 border-t border-border pt-2">
      <summary className="cursor-pointer text-sm text-primary" aria-label={`Correct ${transaction.payee}`}>
        Correct
      </summary>
      <form action={action} className="mt-3 space-y-3">
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
                  {account.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${field}-direction`}>Direction</Label>
            <select
              id={`${field}-direction`}
              name="direction"
              className={selectClass}
              value={direction}
              onChange={(event) => setDirection(event.target.value)}
            >
              <option value="expense">Expense</option>
              <option value="income">Income</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${field}-amount`}>Amount</Label>
            <Input
              id={`${field}-amount`}
              name="amount"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              required
            />
          </div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={`${field}-category-0`}>Category</Label>
            {canSplit ? (
              <button
                type="button"
                className="text-sm text-primary"
                onClick={() => {
                  if (split) {
                    setSplit(false);
                    return;
                  }
                  setSplit(true);
                  setRows((current) => (current.length > 1 ? current : [...current, blankRow(current, categories)]));
                }}
              >
                {split ? "Use one category" : "Split across categories"}
              </button>
            ) : null}
          </div>
          {visible.map((row, index) => (
            <CategoryFields
              key={row.key}
              field={field}
              index={index}
              row={row}
              categories={categories}
              used={used}
              showAmount={split}
              removable={split && rows.length > 2}
              onChange={updateRow}
              onRemove={(key) => setRows((current) => current.filter((item) => item.key !== key))}
            />
          ))}
          {canAdd ? (
            <button
              type="button"
              className="text-sm text-primary"
              onClick={() => setRows((current) => [...current, blankRow(current, categories)])}
            >
              Add a category
            </button>
          ) : null}
          {split ? (
            <p className="text-xs text-muted-foreground">Each part is in dollars. The parts must add up to the amount.</p>
          ) : null}
        </div>
        {state.error ? (
          <p role="alert" className="text-sm text-over">
            {state.error}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <Button type="submit" className="h-10" disabled={pending}>
            {pending ? "Saving" : "Save correction"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            className="h-10"
            onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")}
          >
            Cancel
          </Button>
        </div>
      </form>
    </details>
  );
}

function CategoryFields({
  field,
  index,
  row,
  categories,
  used,
  showAmount,
  removable,
  onChange,
  onRemove,
}: {
  field: string;
  index: number;
  row: SplitRow;
  categories: CategoryMenuEntry[];
  used: Set<string>;
  showAmount: boolean;
  removable: boolean;
  onChange: (key: string, patch: Partial<Pick<SplitRow, "categoryId" | "amount">>) => void;
  onRemove: (key: string) => void;
}) {
  const choices = categories.filter((category) => category.id === row.categoryId || !used.has(category.id));
  const menu = categoryMenuSections(choices);
  return (
    <div className={showAmount ? "grid gap-2 md:grid-cols-[1fr_8rem_auto] md:items-center" : undefined}>
      {menu.isErr() ? (
        <p role="alert" className="text-sm text-over">
          {menu.error.message}
        </p>
      ) : (
        <select
          id={index === 0 ? `${field}-category-0` : undefined}
          name="categoryId"
          aria-label={index === 0 ? "Category" : "Split category"}
          className={selectClass}
          value={row.categoryId}
          onChange={(event) => onChange(row.key, { categoryId: event.target.value })}
          required
        >
          {row.categoryId === "" ? <option value="">Choose a category</option> : null}
          {menu.value.map((section) => (
            <optgroup key={section.id} label={section.label}>
              {section.items.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      )}
      {showAmount ? (
        <Input
          name="splitAmount"
          inputMode="decimal"
          placeholder="0.00"
          aria-label="Split amount"
          value={row.amount}
          onChange={(event) => onChange(row.key, { amount: event.target.value })}
          required
        />
      ) : null}
      {removable ? (
        <button type="button" className="text-sm text-muted-foreground" onClick={() => onRemove(row.key)}>
          Remove
        </button>
      ) : null}
    </div>
  );
}
