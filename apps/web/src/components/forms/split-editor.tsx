"use client";

import {
  MAX_SPLIT_LINES,
  SPLIT_GROUP_COPY,
  categoryMenuSections,
  describeSplitDifference,
  formatCents,
  parseDollarInput,
  splitDifferenceCents,
  splitKindFor,
  type CategoryMenuEntry,
  type SplitCategoryKind,
  type SplitKind,
} from "@dollas/domain";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { toast } from "@/lib/toast-store";
import { saveSplitAction } from "@/slices/splits/actions";

/** "17.94" for -1794 or 1794. */
function unsignedDollarInput(cents: number): string {
  const absolute = Math.abs(cents);
  return `${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

type Option = { id: string; name: string; archived?: boolean };

export type SplitEditorLine = {
  payee: string;
  categoryId: string;
  amountCents: number;
  reimbursed: boolean;
  deposit: { accountId: string } | null;
};

type Row = { key: string; payee: string; categoryId: string; amount: string; reimbursed: boolean; toAccountId: string };

function asKind(kind: string): SplitCategoryKind {
  return kind === "income" || kind === "transfer" ? kind : "expense";
}

/** Cents from a row's amount field, or null while it does not parse. */
function rowCents(row: Row): number | null {
  if (row.amount.trim() === "") return null;
  const parsed = parseDollarInput(row.amount);
  return parsed.isOk() ? Math.abs(parsed.value) : null;
}

/**
 * Split a transaction into child transactions (PEN-348). Shows the kind the
 * split will be (income or allocation) and the difference live, so the lines
 * can be brought to zero before saving.
 */
export function SplitEditor({
  transaction,
  parentCategoryIds,
  lines,
  categories,
  accounts,
  onClose,
}: {
  transaction: { id: string; payee: string; amountCents: number };
  /** The parent's own category ids, which decide income vs allocation. */
  parentCategoryIds: readonly string[];
  /** The current lines when editing an existing split. */
  lines?: readonly SplitEditorLine[];
  categories: CategoryMenuEntry[];
  accounts: Option[];
  onClose: () => void;
}) {
  const field = `split-${transaction.id}`;
  const editing = Boolean(lines && lines.length > 0);
  const kindOf = new Map(categories.map((category) => [category.id, asKind(category.kind)]));
  const kind: SplitKind = splitKindFor({
    amountCents: transaction.amountCents,
    categoryKinds: parentCategoryIds.map((id) => kindOf.get(id) ?? "expense"),
  });
  const [rows, setRows] = useState<Row[]>(() =>
    editing
      ? (lines ?? []).map((line) => ({
          key: crypto.randomUUID(),
          payee: line.payee,
          categoryId: line.categoryId,
          amount: unsignedDollarInput(line.amountCents),
          reimbursed: line.reimbursed,
          toAccountId: line.deposit?.accountId ?? "",
        }))
      : [
          { key: crypto.randomUUID(), payee: transaction.payee, categoryId: "", amount: "", reimbursed: false, toAccountId: "" },
          { key: crypto.randomUUID(), payee: transaction.payee, categoryId: "", amount: "", reimbursed: false, toAccountId: "" },
        ],
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const menu = categoryMenuSections(categories);
  const magnitudes = rows.map((row) => rowCents(row) ?? 0);
  const difference = splitDifferenceCents(transaction.amountCents, magnitudes);
  const charge = transaction.amountCents < 0;

  function change(key: string, patch: Partial<Row>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  async function save() {
    setError("");
    if (rows.some((row) => row.categoryId === "")) return setError("Choose a category for every line.");
    if (rows.some((row) => rowCents(row) == null || rowCents(row) === 0)) return setError("Give every line an amount.");
    setSaving(true);
    const result = await saveSplitAction({
      transactionId: transaction.id,
      editing,
      lines: rows.map((row) => ({
        payee: row.payee.trim() || null,
        categoryId: row.categoryId,
        amountCents: rowCents(row),
        remainderPercent: null,
        toAccountId: kind === "income" && row.toAccountId ? row.toAccountId : null,
        reimbursed: kind === "allocation" && charge ? row.reimbursed : false,
        note: null,
      })),
    });
    setSaving(false);
    if (result.error) return setError(result.error);
    toast(editing ? "Split saved." : `Split ${transaction.payee} into ${rows.length} lines.`);
    onClose();
  }

  return (
    <section id={`${field}-panel`} aria-label={`${editing ? SPLIT_GROUP_COPY.edit : SPLIT_GROUP_COPY.action}: ${transaction.payee}`} className="space-y-3">
      <p className="text-sm text-muted-foreground">
        <span className="font-semibold text-foreground">{kind === "income" ? "Income split." : "Split."}</span>{" "}
        {kind === "income" ? SPLIT_GROUP_COPY.incomeHint : SPLIT_GROUP_COPY.allocationHint}
      </p>
      <ol className="space-y-3">
        {rows.map((row, index) => {
          const transfer = kindOf.get(row.categoryId) === "transfer";
          return (
            <li key={row.key} className="space-y-2 rounded-md border-2 border-dashed border-border-soft p-2">
              <div className="grid gap-2 md:grid-cols-[1fr_1fr_8rem_auto] md:items-end">
                <div className="space-y-1">
                  <Label htmlFor={`${field}-payee-${index}`}>Line {index + 1} payee</Label>
                  <Input id={`${field}-payee-${index}`} value={row.payee} onChange={(event) => change(row.key, { payee: event.target.value })} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${field}-category-${index}`}>Category</Label>
                  {menu.isErr() ? (
                    <FieldError>{menu.error.message}</FieldError>
                  ) : (
                    <Select id={`${field}-category-${index}`} value={row.categoryId} onChange={(event) => change(row.key, { categoryId: event.target.value })}>
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
                    </Select>
                  )}
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`${field}-amount-${index}`}>Amount</Label>
                  <Input
                    id={`${field}-amount-${index}`}
                    inputMode="decimal"
                    placeholder="0.00"
                    value={row.amount}
                    onChange={(event) => change(row.key, { amount: event.target.value })}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={rows.length === 1}
                  aria-label={`${SPLIT_GROUP_COPY.removeLine} line ${index + 1}`}
                  onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}
                >
                  {SPLIT_GROUP_COPY.removeLine}
                </Button>
              </div>
              {kind === "income" && transfer ? (
                <div className="space-y-1">
                  <Label htmlFor={`${field}-deposit-${index}`}>{SPLIT_GROUP_COPY.toAccount} (optional)</Label>
                  <Select id={`${field}-deposit-${index}`} value={row.toAccountId} onChange={(event) => change(row.key, { toAccountId: event.target.value })}>
                    <option value="">No deposit</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.name}
                      </option>
                    ))}
                  </Select>
                </div>
              ) : null}
              {kind === "allocation" && charge ? (
                <div className="flex min-h-11 items-center gap-2 text-sm" title={SPLIT_GROUP_COPY.reimbursedHint}>
                  <Checkbox
                    id={`${field}-${row.key}-reimbursed`}
                    checked={row.reimbursed}
                    onCheckedChange={(checked) => change(row.key, { reimbursed: checked === true })}
                  />
                  <Label htmlFor={`${field}-${row.key}-reimbursed`}>{SPLIT_GROUP_COPY.reimbursed}</Label>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={rows.length >= MAX_SPLIT_LINES}
          onClick={() => setRows((current) => [...current, { key: crypto.randomUUID(), payee: transaction.payee, categoryId: "", amount: "", reimbursed: false, toAccountId: "" }])}
        >
          {SPLIT_GROUP_COPY.addLine}
        </Button>
        <p role="status" aria-live="polite" className={`text-sm font-semibold tabular-nums ${difference === 0 ? "text-income" : "text-over"}`}>
          {formatCents(Math.abs(transaction.amountCents))} total · {describeSplitDifference(difference)}
        </p>
      </div>
      {error ? <FieldError>{error}</FieldError> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving" : editing ? "Save split" : SPLIT_GROUP_COPY.action}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
