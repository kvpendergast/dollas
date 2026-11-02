"use client";

import { SPLIT_GROUP_COPY, TRANSFER_PAIR_COPY, formatCents, type CategoryMenuEntry } from "@dollas/domain";
import { Repeat } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { UndoBar } from "@/components/app/undo-bar";
import { toast } from "@/lib/toast-store";
import { restoreTransactionAction } from "@/slices/activity/actions";
import type { ListedSplit } from "@/slices/activity/transactions";
import { TransactionEditor } from "./transaction-editor";

const UNDO_MS = 8_000;
/** Matches --motion-base: the row slides out, then hides. */
const LEAVE_MS = 200;

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
  recurring?: { id: string; name: string } | null;
  sources?: Array<"manual" | "csv" | "bank">;
  addedBy?: { id: string; name: string } | null;
  categorizedBy?: { id: string; name: string } | null;
  note?: string | null;
  splits: Array<{ categoryId: string; categoryName: string; amountCents: number }>;
  splitGroup?: ListedSplit | null;
  linkedTo?: { lineId: string; parentId: string; parentPayee: string } | null;
  accounts: AccountChoice[];
};

const SOURCE_WORDS = { manual: "Entered", csv: "Imported", bank: "From the bank" } as const;

/** "Imported by Ada · categorized by Ben", "From the bank · Unknown" for rows before attribution. */
function attributionLine(item: Pick<LedgerTransaction, "sources" | "addedBy" | "categorizedBy">): string {
  // A CSV row the bank matched already wears a "Matched to bank" badge; call it imported.
  const sources = item.sources ?? ["manual"];
  const source = SOURCE_WORDS[sources.includes("csv") ? "csv" : sources.includes("bank") ? "bank" : "manual"];
  const added = `${source} by ${item.addedBy ? item.addedBy.name : "Unknown"}`;
  if (item.categorizedBy && item.categorizedBy.id !== item.addedBy?.id) return `${added} · categorized by ${item.categorizedBy.name}`;
  return added;
}

export function ActivityLedger({
  transactions,
  categories,
  recurringChoices = [],
}: {
  transactions: LedgerTransaction[];
  categories: CategoryMenuEntry[];
  recurringChoices?: Array<{ id: string; name: string }>;
}) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(new Set());
  // Rows on screen at first render arrive with the page; only later rows animate in.
  const [initialIds] = useState(() => new Set(transactions.map((item) => item.id)));
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
    toast(`Restored ${undo.payee}.`);
    setLeaving((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    setHidden((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    setUndo(null);
  }

  // Lines and deposits of a split on this page nest under it; a line whose parent is on another page stands alone.
  const parentsHere = new Set(transactions.filter((item) => item.splitGroup?.role === "parent").map((item) => item.id));
  const visible = transactions.filter(
    (item) => !hidden.has(item.id) && !(item.splitGroup && item.splitGroup.role !== "parent" && parentsHere.has(item.splitGroup.parentId)),
  );

  return (
    <div className="overflow-hidden rounded-md border-2 border-foreground bg-card shadow-soft">
      {visible.map((item) => {
        const group = item.splitGroup ?? null;
        const parent = group?.role === "parent" ? group : null;
        const child = group && group.role !== "parent" ? group : null;
        const split = item.splits.length > 1 && !parent;
        return (
          <article
            key={item.id}
            className={`border-t-2 border-dashed border-border-soft px-4 py-3 first:border-t-0 ${leaving.has(item.id) ? "dl-item-leaving" : initialIds.has(item.id) ? "" : "dl-item"}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium break-words">{item.payee}</p>
                <p className="text-xs text-muted-foreground">
                  {item.occurredOn} · {item.accountName}
                  {item.accountArchived ? " · Archived" : ""}
                  {split ? "" : ` · ${item.splits[0]?.categoryName ?? "Uncategorized"}`}
                </p>
                {child ? (
                  <p className="text-xs text-muted-foreground" data-split-orphan>
                    {SPLIT_GROUP_COPY.partOf}: {child.parentPayee}
                    {child.role === "line" && child.reimbursed ? ` · ${SPLIT_GROUP_COPY.reimbursed}` : ""}
                  </p>
                ) : null}
                {item.note ? <p className="text-xs text-muted-foreground">{item.note}</p> : null}
                {item.sources ? <p className="text-xs text-muted-foreground">{attributionLine(item)}</p> : null}
              </div>
              <div className="shrink-0 text-right">
                <p className={`font-heading text-lg tabular-nums ${item.amountCents > 0 ? "text-income" : ""}`}>
                  {formatCents(item.amountCents)}
                </p>
                <div className="flex flex-wrap justify-end gap-1">
                  {item.recurring ? (
                    <Badge asChild variant="outline" className="border-primary/40 text-primary">
                      <Link href={`/recurring/${item.recurring.id}`} title={`Linked to the recurring item ${item.recurring.name}`}>
                        <Repeat aria-hidden="true" />
                        {item.recurring.name}
                      </Link>
                    </Badge>
                  ) : null}
                  {item.bankMatched ? (
                    <Badge variant="outline" title="Bank sync matched this to your entry instead of adding a copy.">
                      Matched to bank
                    </Badge>
                  ) : null}
                  {split ? <Badge variant="secondary">Split</Badge> : null}
                  {item.linkedTo ? (
                    <Badge variant="outline" className="border-primary/40 text-primary" title={TRANSFER_PAIR_COPY.hint} data-transfer-linked>
                      {TRANSFER_PAIR_COPY.deposit} {item.linkedTo.parentPayee}
                    </Badge>
                  ) : null}
                  {parent ? (
                    <Badge variant="secondary" title={parent.kind === "income" ? SPLIT_GROUP_COPY.incomeHint : SPLIT_GROUP_COPY.allocationHint}>
                      {parent.kind === "income" ? "Income split" : "Split"}
                    </Badge>
                  ) : null}
                </div>
              </div>
            </div>
            {split ? (
              <ul className="mt-3 space-y-1 border-t-2 border-dashed border-border-soft pt-2 text-sm">
                {item.splits.map((part, index) => (
                  <li key={`${part.categoryId}-${index}`} className="flex justify-between gap-3">
                    <span>{part.categoryName}</span>
                    <span className="tabular-nums">{formatCents(part.amountCents)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {parent ? (
              <ul aria-label={`Lines of ${item.payee}`} className="mt-3 space-y-1 border-l-4 border-border-soft pl-3 text-sm">
                {parent.view.lines.map((line) => (
                  <li key={line.id} data-split-line>
                    <div className="flex justify-between gap-3">
                      <span className="min-w-0 break-words">
                        {line.payee}
                        <span className="text-xs text-muted-foreground"> · {line.categoryName ?? "Uncategorized"}</span>
                        {line.reimbursed ? (
                          <Badge variant="outline" className="ml-1" title={SPLIT_GROUP_COPY.reimbursedHint}>
                            {SPLIT_GROUP_COPY.reimbursed}
                          </Badge>
                        ) : null}
                      </span>
                      <span className="shrink-0 tabular-nums">{formatCents(line.amountCents)}</span>
                    </div>
                    {line.deposit ? (
                      <div className="flex justify-between gap-3 text-xs text-muted-foreground">
                        <span>
                          {SPLIT_GROUP_COPY.toAccount} {line.deposit.accountName}
                        </span>
                        <span className="tabular-nums text-income">{formatCents(line.deposit.amountCents)}</span>
                      </div>
                    ) : null}
                    {line.linked ? (
                      <div className="flex justify-between gap-3 text-xs text-muted-foreground" data-transfer-linked>
                        <span>
                          {TRANSFER_PAIR_COPY.linkedTo}: {line.linked.accountName} · {line.linked.occurredOn}
                          {line.linked.deleted ? " · Deleted" : ""}
                        </span>
                        <span className="tabular-nums text-income">{formatCents(line.linked.amountCents)}</span>
                      </div>
                    ) : null}
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
                item.note ?? "",
                item.bankMatched ? "matched" : "",
                item.recurring?.id ?? "",
                item.splits.map((part) => `${part.categoryId}:${part.amountCents}`).join(","),
                parent ? parent.view.lines.map((line) => `${line.categoryId}:${line.amountCents}:${line.reimbursed}:${line.deposit?.accountId ?? ""}:${line.linked?.id ?? ""}`).join(",") : group?.role ?? "",
                item.linkedTo?.lineId ?? "",
              ].join("|")}
              transaction={item}
              accounts={item.accounts}
              categories={categories}
              recurringChoices={recurringChoices}
              onDeleted={(deleted) => {
                setLeaving((current) => new Set(current).add(deleted.id));
                window.setTimeout(() => setHidden((current) => new Set(current).add(deleted.id)), LEAVE_MS);
                setUndoError("");
                setUndo(deleted);
              }}
            />
          </article>
        );
      })}
      {undo ? (
        <UndoBar
          message={`Deleted ${undo.payee}.`}
          actionLabel="Undo"
          pendingLabel="Restoring"
          pending={restoring}
          error={undoError}
          buttonRef={undoButton}
          onAction={() => void undoDelete()}
        />
      ) : null}
    </div>
  );
}
