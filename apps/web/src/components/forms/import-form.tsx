"use client";

import { useActionState, useState, startTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  importCsvAction,
  undoCsvImportAction,
  type ImportPreview,
  type OpenCsvImport,
} from "@/slices/activity/import-csv";

const initial = { error: "", message: "", preview: null };
const undoInitial = { error: "", message: "" };

export function ImportForm({ batches, undoneNotice }: { batches: OpenCsvImport[]; undoneNotice: string }) {
  const [state, action, pending] = useActionState(importCsvAction, initial);
  const [stamp, setStamp] = useState("");
  const [intent, setIntent] = useState("");
  const preview = state.preview && state.preview.stamp === stamp ? state.preview : null;

  return (
    <div className="space-y-6">
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          const submitter = event.nativeEvent.submitter;
          const nextIntent = submitter instanceof HTMLButtonElement ? submitter.value : "preview";
          if (nextIntent) formData.set("intent", nextIntent);
          setIntent(nextIntent);
          startTransition(() => {
            action(formData);
          });
        }}
      >
        <p className="text-sm text-muted-foreground">
          Columns are date, payee, amount, account, and category. Amounts are dollars and cents. Negative amounts are
          expenses and positive amounts are income. Account names have to match this household. A payee rule sets the
          category when the payee contains its text. Otherwise the category name has to match. Preview the file before
          it is added.
        </p>
        <pre className="overflow-x-auto rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{`date,payee,amount,account,category
2026-03-02,Market,-86.40,Checking,Groceries`}</pre>
        <input type="hidden" name="stamp" value={stamp} />
        <div className="space-y-1.5">
          <Label htmlFor="csv-file">CSV file</Label>
          <Input
            id="csv-file"
            name="csv"
            type="file"
            accept=".csv,text/csv"
            required
            onChange={(event) => {
              const file = event.target.files?.[0];
              setStamp(file ? `${file.name}:${file.size}:${file.lastModified}` : "");
            }}
          />
        </div>
        {state.error ? (
          <p role="alert" className="text-sm text-over">
            {state.error}
          </p>
        ) : null}
        {state.message ? (
          <p role="status" className="text-sm text-muted-foreground">
            {state.message}
          </p>
        ) : null}
        {preview ? <ImportPreviewTable preview={preview} /> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" name="intent" value="preview" className="h-10" disabled={pending}>
            {pending && intent === "preview" ? "Checking" : "Preview import"}
          </Button>
          {preview && preview.newCount > 0 ? (
            <Button type="submit" name="intent" value="commit" variant="secondary" className="h-10" disabled={pending}>
              {pending && intent === "commit"
                ? "Importing"
                : preview.newCount === 1
                  ? "Import 1 new transaction"
                  : `Import ${preview.newCount} new transactions`}
            </Button>
          ) : null}
        </div>
      </form>
      <OpenImports batches={batches} undoneNotice={undoneNotice} />
    </div>
  );
}

function ImportPreviewTable({ preview }: { preview: ImportPreview }) {
  const newLabel = preview.newCount === 1 ? "1 new" : `${preview.newCount} new`;
  const alreadyLabel =
    preview.alreadyCount === 1 ? "1 already in the books" : `${preview.alreadyCount} already in the books`;
  return (
    <section aria-label="Import preview" className="space-y-2">
      <p className="text-sm">
        <span className="font-medium text-income">{newLabel}</span>
        <span className="text-muted-foreground"> · {alreadyLabel}</span>
      </p>
      <p className="text-sm text-muted-foreground">
        Already in the books includes transactions you deleted. Those stay deleted and are not added again.
      </p>
      <div className="max-h-80 overflow-auto rounded-lg ring-1 ring-foreground/10">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <caption className="sr-only">Parsed CSV rows</caption>
          <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Date
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Payee
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Amount
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Account
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Category
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, index) => (
              <tr key={`${row.line}-${index}`} className="border-t border-border">
                <td className="px-3 py-2 whitespace-nowrap">{row.occurredOn}</td>
                <td className="px-3 py-2">{row.payee}</td>
                <td className="px-3 py-2 whitespace-nowrap">{row.amount}</td>
                <td className="px-3 py-2">{row.accountName}</td>
                <td className="px-3 py-2">{row.categoryName}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {row.status === "new" ? (
                    <span className="text-income">New</span>
                  ) : (
                    <span className="text-muted-foreground">Already in the books</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OpenImports({ batches, undoneNotice }: { batches: OpenCsvImport[]; undoneNotice: string }) {
  const [state, action, pending] = useActionState(undoCsvImportAction, undoInitial);
  const notice = state.message || undoneNotice;
  if (batches.length === 0 && !notice && !state.error) return null;
  return (
    <section aria-label="Imports you can undo" className="space-y-3">
      <div>
        <h2 className="text-sm font-medium">Imports you can undo</h2>
        <p className="text-sm text-muted-foreground">
          Undo removes only the transactions that import added, including ones you had deleted from that import. You
          can import that file again afterwards. Payee rules, transactions you entered yourself, and other imports stay
          as they are.
        </p>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-over">
          {state.error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {batches.length > 0 ? (
        <ul className="divide-y divide-border">
          {batches.map((batch) => (
            <li key={batch.id} className="py-3 first:pt-0 last:pb-0">
              <UndoImport batch={batch} action={action} pending={pending} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function UndoImport({
  batch,
  action,
  pending,
}: {
  batch: OpenCsvImport;
  action: (payload: FormData) => void;
  pending: boolean;
}) {
  const count = batch.addedCount === 1 ? "1 transaction" : `${batch.addedCount} transactions`;
  const when = batch.createdAt.slice(0, 10);
  return (
    <form action={action} className="flex flex-wrap items-center justify-between gap-3">
      <input type="hidden" name="batchId" value={batch.id} />
      <p className="text-sm">
        {count} · {when}
      </p>
      <Button type="submit" variant="outline" className="h-10" disabled={pending}>
        {pending ? "Undoing" : "Undo import"}
      </Button>
    </form>
  );
}
