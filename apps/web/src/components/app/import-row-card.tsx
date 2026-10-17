import * as React from "react";
import { StatusPill } from "@/components/app/status-pill";
import type { ImportPreview } from "@/slices/activity/import-csv";

type PreviewRow = ImportPreview["rows"][number];

/**
 * ImportRowCard: one CSV row as a card on phones (Row n, status, labelled values, cell errors
 * in the error tint). Desktop shows the same rows in a Table. Marked data-import-card for tests.
 */
export function ImportRowCard({ row, labels }: { row: PreviewRow; labels: string[] }) {
  return (
    <li data-import-card className="rounded-md border-2 border-foreground bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-heading text-xs font-extrabold tracking-wider uppercase">Row {row.line}</span>
        {row.status === "ready" ? (
          <StatusPill status="ready" />
        ) : row.status === "error" ? (
          <StatusPill status="error" />
        ) : (
          <span className="text-xs font-bold text-muted-foreground">
            {row.duplicateOf === "bank" ? "Already synced from bank" : "Duplicate"}
          </span>
        )}
      </div>
      <dl className="mt-2 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1.5 text-sm">
        {row.cells.map((cell, index) => (
          <React.Fragment key={cell.field}>
            <dt className="text-xs font-bold text-muted-foreground">{labels[index] ?? cell.field}</dt>
            <dd
              className={cell.message ? "min-w-0 rounded-sm border-2 border-destructive bg-error-tint px-2 py-1 font-medium break-words text-destructive" : "min-w-0 break-words"}
            >
              {cell.text || (cell.message ? "" : "—")}
              {cell.message ? <span className="mt-0.5 block text-xs">{cell.message}</span> : null}
            </dd>
          </React.Fragment>
        ))}
      </dl>
      {row.status === "ready" && row.possibleTransfer ? (
        <p className="mt-2 text-xs text-muted-foreground">Looks like a transfer or card payment. {row.possibleTransfer}</p>
      ) : null}
    </li>
  );
}
