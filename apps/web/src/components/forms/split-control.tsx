"use client";

import {
  SPLIT_CONTROL_COPY,
  canAddSplit,
  categoryMenuSections,
  directionCategoryNotice,
  directionDefaultForKind,
  type CategoryMenuEntry,
  type DirectionCategoryNotice,
  type TransactionDirection,
} from "@dollas/domain";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type SplitRow = {
  key: string;
  categoryId: string;
  amount: string;
};

const selectClass = "h-10 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm";

function blankRow(existing: readonly SplitRow[], categories: readonly CategoryMenuEntry[]): SplitRow {
  const used = new Set(existing.map((row) => row.categoryId));
  const categoryId = categories.find((category) => !used.has(category.id))?.id ?? "";
  return { key: crypto.randomUUID(), categoryId, amount: "" };
}

function kindOf(categories: readonly CategoryMenuEntry[], categoryId: string): string {
  return categories.find((category) => category.id === categoryId)?.kind ?? "";
}

function noticesFor(
  rows: readonly SplitRow[],
  categories: readonly CategoryMenuEntry[],
  direction: TransactionDirection,
): DirectionCategoryNotice[] {
  const seen = new Set<string>();
  const notices: DirectionCategoryNotice[] = [];
  for (const row of rows) {
    const notice = directionCategoryNotice(direction, kindOf(categories, row.categoryId));
    if (!notice || seen.has(notice.message)) continue;
    seen.add(notice.message);
    notices.push(notice);
  }
  notices.sort((a, b) => {
    if (a.tone === b.tone) return 0;
    return a.tone === "warning" ? -1 : 1;
  });
  return notices;
}

export function SplitControl({
  fieldId,
  categories,
  initialDirection,
  initialRows,
  initialSplit,
}: {
  fieldId: string;
  categories: CategoryMenuEntry[];
  initialDirection: TransactionDirection;
  initialRows: SplitRow[];
  initialSplit: boolean;
}) {
  const [direction, setDirection] = useState<TransactionDirection>(initialDirection);
  const [split, setSplit] = useState(initialSplit);
  const [rows, setRows] = useState<SplitRow[]>(
    initialRows.length > 0 ? initialRows : [{ key: "primary", categoryId: "", amount: "" }],
  );
  const visible = split ? rows : rows.slice(0, 1);
  const used = new Set(visible.map((row) => row.categoryId));
  const canSplit = categories.length > 1;
  const canAdd = split && canAddSplit(visible.length, categories.length);
  const notices = noticesFor(visible, categories, direction);

  function applyDefault(categoryId: string) {
    const next = directionDefaultForKind(kindOf(categories, categoryId));
    if (next) setDirection(next);
  }

  function updateRow(key: string, patch: Partial<Pick<SplitRow, "categoryId" | "amount">>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    if (patch.categoryId && !split) applyDefault(patch.categoryId);
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor={`${fieldId}-direction`}>Direction</Label>
        <select
          id={`${fieldId}-direction`}
          name="direction"
          className={selectClass}
          value={direction}
          onChange={(event) => setDirection(event.target.value === "income" ? "income" : "expense")}
        >
          <option value="expense">Expense</option>
          <option value="income">Income</option>
        </select>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={`${fieldId}-category-0`}>Category</Label>
          {canSplit ? (
            <button
              type="button"
              className="inline-flex h-10 items-center text-sm text-primary"
              onClick={() => {
                if (split) {
                  setSplit(false);
                  applyDefault(rows[0]?.categoryId ?? "");
                  return;
                }
                setSplit(true);
                setRows((current) => (current.length > 1 ? current : [...current, blankRow(current, categories)]));
              }}
            >
              {split ? SPLIT_CONTROL_COPY.single : SPLIT_CONTROL_COPY.split}
            </button>
          ) : null}
        </div>
        {visible.map((row, index) => (
          <CategoryFields
            key={row.key}
            fieldId={fieldId}
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
            className="inline-flex h-10 items-center text-sm text-primary"
            onClick={() => setRows((current) => [...current, blankRow(current, categories)])}
          >
            {SPLIT_CONTROL_COPY.add}
          </button>
        ) : null}
        {notices.map((notice) => (
          <p
            key={notice.message}
            role="status"
            className={notice.tone === "warning" ? "text-sm text-over" : "text-sm text-muted-foreground"}
          >
            {notice.message}
          </p>
        ))}
        {split ? (
          <p className="text-xs text-muted-foreground">
            {SPLIT_CONTROL_COPY.hint} {SPLIT_CONTROL_COPY.limit}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function CategoryFields({
  fieldId,
  index,
  row,
  categories,
  used,
  showAmount,
  removable,
  onChange,
  onRemove,
}: {
  fieldId: string;
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
          id={index === 0 ? `${fieldId}-category-0` : undefined}
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
          className="h-10"
          inputMode="decimal"
          placeholder="0.00"
          aria-label="Split amount"
          value={row.amount}
          onChange={(event) => onChange(row.key, { amount: event.target.value })}
          required
        />
      ) : null}
      {removable ? (
        <button type="button" className="inline-flex h-10 items-center text-sm text-muted-foreground" onClick={() => onRemove(row.key)}>
          {SPLIT_CONTROL_COPY.remove}
        </button>
      ) : null}
    </div>
  );
}
