"use client";

import { formatCents, type CopyBudgetLine } from "@dollas/domain";
import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { copyPreviousMonthAction } from "@/slices/plan/actions";
import { useActionToast } from "@/lib/use-action-toast";

export function CopyBudgetsForm({
  monthKey,
  fromLabel,
  toLabel,
  copies,
  overwrites,
  unchangedCount,
}: {
  monthKey: string;
  fromLabel: string;
  toLabel: string;
  copies: CopyBudgetLine[];
  overwrites: CopyBudgetLine[];
  unchangedCount: number;
}) {
  const [state, action, pending] = useActionState(copyPreviousMonthAction, { error: "" });
  useActionToast(state, (s) => ("notice" in s && typeof s.notice === "string" && s.notice) || "Budgets copied from last month.");
  const nothingToApply = copies.length === 0 && overwrites.length === 0;
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="month" value={monthKey} />
      <p className="text-sm text-muted-foreground">
        Copy {fromLabel} into {toLabel}. Budgets already set this month stay as they are unless you confirm overwrite.
      </p>
      {copies.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Will be copied</h3>
          <ul className="space-y-1 text-sm">
            {copies.map((line) => (
              <li key={line.categoryId} className="flex justify-between gap-3">
                <span>{lineLabel(line)}</span>
                <span className="tabular-nums">{formatCents(line.previousCents)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {overwrites.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Already set this month</h3>
          <ul className="space-y-1 text-sm">
            {overwrites.map((line) => (
              <li key={line.categoryId} className="flex justify-between gap-3">
                <span>{lineLabel(line)}</span>
                <span className="tabular-nums text-muted-foreground">
                  {formatCents(line.currentCents ?? 0)} now, {formatCents(line.previousCents)} last month
                </span>
              </li>
            ))}
          </ul>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              name="overwrite"
              value="yes"
              className="mt-1 accent-primary"
              required={copies.length === 0}
            />
            <span>Overwrite budgets already set this month</span>
          </label>
        </div>
      ) : null}
      {nothingToApply ? (
        <p className="text-sm">
          {unchangedCount > 0 ? "This month already matches last month." : "Last month has no budgets to copy."}
        </p>
      ) : null}
      {state.error ? (
        <p role="alert" className="text-sm text-over">
          {state.error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {nothingToApply ? null : (
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Copying" : "Copy budgets"}
          </Button>
        )}
        <Button asChild variant="outline" size="sm">
          <Link href={`/plan?month=${monthKey}`}>Cancel</Link>
        </Button>
      </div>
    </form>
  );
}

function lineLabel(line: CopyBudgetLine): string {
  return line.groupName ? `${line.groupName} · ${line.name}` : line.name;
}
