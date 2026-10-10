"use client";

import { formatCents, type CategoryMenuEntry } from "@dollas/domain";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { restoreTransactionAction } from "@/slices/activity/actions";
import { TransactionEditor } from "./transaction-editor";

const UNDO_MS = 8_000;

type AccountChoice = { id: string; name: string; archived?: boolean };

type LedgerTransaction = {
  id: string;
  occurredOn: string;
  payee: string;
  amountCents: number;
  accountId: string;
  accountName: string;
  accountArchived: boolean;
  bankMatched?: boolean;
  splits: Array<{ categoryId: string; categoryName: string; amountCents: number }>;
  accounts: AccountChoice[];
};

export function ActivityLedger({
  transactions,
  categories,
}: {
  transactions: LedgerTransaction[];
  categories: CategoryMenuEntry[];
}) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [undo, setUndo] = useState<{ id: string; payee: string } | null>(null);
  const [undoError, setUndoError] = useState("");
  const [restoring, setRestoring] = useState(false);
  const undoButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!undo) return;
    undoButton.current?.focus();
    const timer = window.setTimeout(() => setUndo(null), UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [undo]);

  async function undoDelete() {
    if (!undo || restoring) return;
    setRestoring(true);
    setUndoError("");
    const result = await restoreTransactionAction(undo.id);
    setRestoring(false);
    if (result.error) {
      setUndoError(result.error);
      return;
    }
    const id = undo.id;
    setHidden((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    setUndo(null);
  }

  const visible = transactions.filter((item) => !hidden.has(item.id));

  return (
    <div className="space-y-3">
      {visible.map((item) => {
        const split = item.splits.length > 1;
        return (
          <article key={item.id} className="rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium">{item.payee}</p>
                <p className="text-xs text-muted-foreground">
                  {item.occurredOn} · {item.accountName}
                  {item.accountArchived ? " · Archived" : ""}
                  {split ? "" : ` · ${item.splits[0]?.categoryName ?? "Uncategorized"}`}
                </p>
              </div>
              <div className="text-right">
                <p className={`font-serif text-lg tabular-nums ${item.amountCents > 0 ? "text-income" : ""}`}>
                  {formatCents(item.amountCents)}
                </p>
                <div className="flex flex-wrap justify-end gap-1">
                  {item.bankMatched ? (
                    <Badge variant="outline" title="Bank sync matched this to your entry instead of adding a copy.">
                      Matched to bank
                    </Badge>
                  ) : null}
                  {split ? <Badge variant="secondary">Split</Badge> : null}
                </div>
              </div>
            </div>
            {split ? (
              <ul className="mt-3 space-y-1 border-t border-border pt-2 text-sm">
                {item.splits.map((part, index) => (
                  <li key={`${part.categoryId}-${index}`} className="flex justify-between gap-3">
                    <span>{part.categoryName}</span>
                    <span className="tabular-nums">{formatCents(part.amountCents)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <TransactionEditor
              key={[
                item.id,
                item.payee,
                item.occurredOn,
                item.accountId,
                item.amountCents,
                item.bankMatched ? "matched" : "",
                item.splits.map((part) => `${part.categoryId}:${part.amountCents}`).join(","),
              ].join("|")}
              transaction={item}
              accounts={item.accounts}
              categories={categories}
              onDeleted={(deleted) => {
                setHidden((current) => new Set(current).add(deleted.id));
                setUndoError("");
                setUndo(deleted);
              }}
            />
          </article>
        );
      })}
      {undo ? (
        <div
          role="status"
          className="fixed inset-x-4 bottom-24 z-30 mx-auto flex max-w-md flex-col gap-2 rounded-xl bg-card px-4 py-3 shadow-lg ring-1 ring-foreground/10 md:bottom-8"
        >
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm">Deleted {undo.payee}.</p>
            <Button
              ref={undoButton}
              type="button"
              variant="outline"
              className="h-10"
              disabled={restoring}
              onClick={() => void undoDelete()}
            >
              {restoring ? "Restoring" : "Undo"}
            </Button>
          </div>
          {undoError ? (
            <p role="alert" className="text-sm text-over">
              {undoError}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
