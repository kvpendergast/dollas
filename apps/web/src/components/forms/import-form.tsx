"use client";

import { FieldError } from "@/components/ui/field";

import type { ColumnMapping } from "@dollas/domain";
import * as React from "react";
import { useActionState, useState, startTransition } from "react";
import { StatusPill } from "@/components/app/status-pill";
import { ImportRowCard } from "@/components/app/import-row-card";
import { Button } from "@/components/ui/button";
import { FileInput } from "@/components/ui/file-input";
import { Label } from "@/components/ui/label";
import { ChoiceGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Switch } from "@/components/ui/switch";
import {
  importCsvAction,
  undoCsvImportAction,
  type ImportInspection,
  type ImportPreview,
  type OpenCsvImport,
} from "@/slices/activity/import-csv";
import { useActionToast } from "@/lib/use-action-toast";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select } from "@/components/ui/select";

const initial = { error: "", message: "", stage: "upload" as const, stamp: "", inspection: null, preview: null };
const undoInitial = { error: "", message: "" };
export function ImportForm({
  accounts,
  batches,
  undoneNotice,
}: {
  accounts: { id: string; name: string }[];
  batches: OpenCsvImport[];
  undoneNotice: string;
}) {
  const [state, action, pending] = useActionState(importCsvAction, initial);
  useActionToast(state, (s) => s.message || null);
  const [stamp, setStamp] = useState("");
  const [intent, setIntent] = useState("");
  const [draft, setDraft] = useState<{ key: string; mapping: ColumnMapping } | null>(null);
  const [editingPreview, setEditingPreview] = useState("");
  const [errorFilter, setErrorFilter] = useState("");

  const inspectionKey = state.inspection
    ? [
        state.stamp,
        state.inspection.headerSignature,
        state.inspection.hasHeader,
        state.inspection.reusedSavedMapping,
        state.inspection.mapping.amountMode,
        state.inspection.mapping.dateOrder,
        state.inspection.mapping.flipSign,
        state.inspection.mapping.fixedAccountId,
        state.inspection.mapping.dateColumn,
        state.inspection.mapping.payeeColumn,
        state.inspection.mapping.amountColumn,
        state.inspection.mapping.debitColumn,
        state.inspection.mapping.creditColumn,
      ].join("|")
    : "";
  const inspection = state.inspection && state.stamp === stamp ? state.inspection : null;
  const preview = state.preview && state.preview.stamp === stamp && state.stamp === stamp ? state.preview : null;
  const mapping = draft && draft.key === inspectionKey ? draft.mapping : (inspection?.mapping ?? null);
  const previewKey = preview ? `${preview.stamp}:${preview.readyCount}:${preview.errorCount}:${preview.rows.length}` : "";
  const errorsOnly = errorFilter === previewKey && previewKey !== "";
  const editing = editingPreview === previewKey && previewKey !== "";
  const showMapper = Boolean(inspection && mapping && (editing || state.stage !== "preview" || !preview));
  const showPreview = Boolean(preview && !showMapper);

  function updateMapping(next: ColumnMapping) {
    setDraft({ key: inspectionKey, mapping: next });
  }

  return (
    <div className="space-y-6">
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          const submitter = event.nativeEvent.submitter;
          const nextIntent = submitter instanceof HTMLButtonElement ? submitter.value : "inspect";
          formData.set("intent", nextIntent);
          setIntent(nextIntent);
          startTransition(() => {
            action(formData);
          });
        }}
      >
        <input type="hidden" name="stamp" value={stamp} />
        {(showMapper || showPreview) && mapping ? <MappingFields mapping={mapping} /> : null}
        <div className="space-y-1.5">
          <Label htmlFor="csv-file">CSV file</Label>
          <FileInput
            id="csv-file"
            name="csv"
            accept=".csv,text/csv"
            required
            onChange={(event) => {
              const file = event.target.files?.[0];
              setStamp(file ? `${file.name}:${file.size}:${file.lastModified}` : "");
              setEditingPreview("");
            }}
          />
        </div>
        {state.error ? (
          <FieldError>
            {state.error}
          </FieldError>
        ) : null}
        {state.message ? (
          <p role="status" className="text-sm text-muted-foreground">
            {state.message}
          </p>
        ) : null}
        {showMapper && inspection && mapping ? (
          <Mapper
            inspection={inspection}
            mapping={mapping}
            accounts={accounts}
            pending={pending}
            onChange={updateMapping}
            onToggleHeader={(form) => {
              const data = new FormData(form);
              data.set("intent", "inspect");
              data.set("hasHeader", mapping.hasHeader ? "0" : "1");
              setIntent("inspect");
              startTransition(() => {
                action(data);
              });
            }}
          />
        ) : null}
        {showPreview && preview ? (
          <ImportPreviewTable
            preview={preview}
            errorsOnly={errorsOnly}
            onToggleErrors={() => setErrorFilter(errorsOnly ? "" : previewKey)}
          />
        ) : null}
        {inspection && mapping?.categoryColumn != null ? (
          <div className="space-y-1.5">
            <Label htmlFor="import-unmatched-categories">Categories Dollas doesn&apos;t know</Label>
            <Select id="import-unmatched-categories" name="unmatchedCategories" defaultValue="error">
              <option value="error">Flag those rows so I can fix them</option>
              <option value="uncategorized">Import them as Uncategorized</option>
              <option value="create">Create a category for each new name</option>
            </Select>
          </div>
        ) : null}
        <div
          className={
            showPreview
              ? "sticky bottom-[calc(3.75rem+env(safe-area-inset-bottom))] z-10 -mx-1 flex flex-col gap-2 rounded-md border-2 border-foreground bg-card p-2 shadow-pop md:static md:mx-0 md:flex-row md:flex-wrap md:border-0 md:bg-transparent md:p-0 md:shadow-none"
              : "flex flex-wrap gap-2"
          }
        >
          {!inspection ? (
            <Button type="submit" name="intent" value="inspect" disabled={pending}>
              {pending && intent === "inspect" ? "Reading" : "Continue"}
            </Button>
          ) : null}
          {showMapper ? (
            <Button type="submit" name="intent" value="preview" disabled={pending}>
              {pending && intent === "preview" ? "Checking" : "Preview import"}
            </Button>
          ) : null}
          {showPreview && preview && preview.readyCount > 0 ? (
            <Button type="submit" name="intent" value="commit" className="w-full md:w-auto" disabled={pending}>
              {pending && intent === "commit"
                ? "Importing"
                : preview.readyCount === 1
                  ? "Import 1 ready"
                  : `Import ${preview.readyCount} ready`}
            </Button>
          ) : null}
          {showPreview ? (
            <Button type="button" variant="outline" className="w-full md:w-auto" onClick={() => setEditingPreview(previewKey)}>
              Change mapping
            </Button>
          ) : null}
        </div>
      </form>
      <OpenImports batches={batches} undoneNotice={undoneNotice} />
    </div>
  );
}

function MappingFields({ mapping }: { mapping: ColumnMapping }) {
  return (
    <>
      <input type="hidden" name="hasHeader" value={mapping.hasHeader ? "1" : "0"} />
      <input type="hidden" name="dateColumn" value={mapping.dateColumn ?? ""} />
      <input type="hidden" name="payeeColumn" value={mapping.payeeColumn ?? ""} />
      <input type="hidden" name="amountMode" value={mapping.amountMode} />
      <input type="hidden" name="amountColumn" value={mapping.amountColumn ?? ""} />
      <input type="hidden" name="debitColumn" value={mapping.debitColumn ?? ""} />
      <input type="hidden" name="creditColumn" value={mapping.creditColumn ?? ""} />
      <input type="hidden" name="flipSign" value={mapping.flipSign ? "1" : "0"} />
      <input type="hidden" name="dateOrder" value={mapping.dateOrder ?? ""} />
      <input type="hidden" name="accountMode" value={mapping.accountMode} />
      <input type="hidden" name="accountColumn" value={mapping.accountColumn ?? ""} />
      <input type="hidden" name="fixedAccountId" value={mapping.fixedAccountId ?? ""} />
      <input type="hidden" name="categoryColumn" value={mapping.categoryColumn ?? ""} />
      <input type="hidden" name="notesColumn" value={mapping.notesColumn ?? ""} />
    </>
  );
}

function Mapper({
  inspection,
  mapping,
  accounts,
  pending,
  onChange,
  onToggleHeader,
}: {
  inspection: ImportInspection;
  mapping: ColumnMapping;
  accounts: { id: string; name: string }[];
  pending: boolean;
  onChange: (mapping: ColumnMapping) => void;
  onToggleHeader: (form: HTMLFormElement) => void;
}) {
  const columns = inspection.columns;
  return (
    <section aria-label="Match columns" data-import-mapper className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-lg font-extrabold">Match columns</h2>
        <Button
          type="button"
          variant="outline"
         
          disabled={pending}
          onClick={(event) => {
            const form = event.currentTarget.form;
            if (form) onToggleHeader(form);
          }}
        >
          {mapping.hasHeader ? "Use the first row as data" : "Use the first row as column names"}
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Pick the column that fills each field. A payee rule still sets the category when it matches. A blank category
        stays uncategorized.
      </p>
      {inspection.reusedSavedMapping ? (
        <p className="text-sm text-muted-foreground">This file matches a saved mapping. Change it if this bank looks different.</p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <ColumnSelect
          id="map-date"
          label="Date"
          value={mapping.dateColumn}
          columns={columns}
          onChange={(dateColumn) => onChange({ ...mapping, dateColumn })}
        />
        <ColumnSelect
          id="map-payee"
          label="Payee"
          value={mapping.payeeColumn}
          columns={columns}
          onChange={(payeeColumn) => onChange({ ...mapping, payeeColumn })}
        />
        <div className="space-y-1.5 sm:col-span-2">
          <Label id="map-amount-mode-label">Amount</Label>
          <ChoiceGroup
            aria-labelledby="map-amount-mode-label"
            value={mapping.amountMode}
            onValueChange={(value) => onChange({ ...mapping, amountMode: value === "debit_credit" ? "debit_credit" : "signed" })}
          >
            <ToggleGroupItem value="signed">One amount column</ToggleGroupItem>
            <ToggleGroupItem value="debit_credit">Debit and credit columns</ToggleGroupItem>
          </ChoiceGroup>
        </div>
        {mapping.amountMode === "signed" ? (
          <ColumnSelect
            id="map-amount"
            label="Amount column"
            value={mapping.amountColumn}
            columns={columns}
            onChange={(amountColumn) => onChange({ ...mapping, amountColumn })}
          />
        ) : (
          <>
            <ColumnSelect
              id="map-debit"
              label="Debit"
              value={mapping.debitColumn}
              columns={columns}
              onChange={(debitColumn) => onChange({ ...mapping, debitColumn })}
            />
            <ColumnSelect
              id="map-credit"
              label="Credit"
              value={mapping.creditColumn}
              columns={columns}
              onChange={(creditColumn) => onChange({ ...mapping, creditColumn })}
            />
          </>
        )}
        <div className="flex items-start gap-3 sm:col-span-2">
          <Switch
            id="map-flip-sign"
            checked={mapping.flipSign}
            onCheckedChange={(flipSign) => onChange({ ...mapping, flipSign })}
            aria-describedby="map-flip-sign-help"
          />
          <div className="min-w-0">
            <Label htmlFor="map-flip-sign" className="min-h-[30px]">
              Flip sign
            </Label>
            <p id="map-flip-sign-help" className="text-sm text-muted-foreground">
              Turn this on when expenses in this file are positive.
            </p>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="map-date-order">Date format</Label>
          <Select
            id="map-date-order"
           
            value={mapping.dateOrder ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              const dateOrder = value === "ymd" || value === "mdy" || value === "dmy" ? value : null;
              onChange({ ...mapping, dateOrder });
            }}
          >
            <option value="">{inspection.dateOrderAmbiguous ? "Choose a date format" : "Detected from the file"}</option>
            <option value="ymd">Year, month, day</option>
            <option value="mdy">Month, day, year</option>
            <option value="dmy">Day, month, year</option>
          </Select>
          {inspection.dateOrderAmbiguous ? (
            <p className="text-xs text-muted-foreground">These dates could be month-first or day-first.</p>
          ) : null}
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label id="map-account-mode-label">Account</Label>
          <ChoiceGroup
            aria-labelledby="map-account-mode-label"
            value={mapping.accountMode}
            onValueChange={(value) =>
              onChange({
                ...mapping,
                accountMode: value === "column" ? "column" : "fixed",
                fixedAccountId: value === "column" ? null : mapping.fixedAccountId,
              })
            }
          >
            <ToggleGroupItem value="fixed">One account for the whole file</ToggleGroupItem>
            <ToggleGroupItem value="column">A column in the file</ToggleGroupItem>
          </ChoiceGroup>
        </div>
        {mapping.accountMode === "column" ? (
          <ColumnSelect
            id="map-account"
            label="Account column"
            value={mapping.accountColumn}
            columns={columns}
            onChange={(accountColumn) => onChange({ ...mapping, accountColumn })}
          />
        ) : (
          <div className="space-y-1.5">
            <Label htmlFor="map-fixed-account">Dollas account</Label>
            <Select
              id="map-fixed-account"
             
              value={mapping.fixedAccountId ?? ""}
              onChange={(event) => {
                const accountId = event.target.value;
                const saved = mapping.hasHeader
                  ? undefined
                  : inspection.savedForAccounts.find((row) => row.accountId === accountId);
                onChange({
                  ...(saved?.mapping ?? mapping),
                  hasHeader: mapping.hasHeader,
                  accountMode: "fixed",
                  fixedAccountId: accountId || null,
                });
              }}
            >
              <option value="">Choose an account</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <ColumnSelect
          id="map-category"
          label="Category (optional)"
          value={mapping.categoryColumn}
          columns={columns}
          allowEmpty
          onChange={(categoryColumn) => onChange({ ...mapping, categoryColumn })}
        />
        <ColumnSelect
          id="map-notes"
          label="Notes (optional)"
          value={mapping.notesColumn}
          columns={columns}
          allowEmpty
          onChange={(notesColumn) => onChange({ ...mapping, notesColumn })}
        />
      </div>
      <SampleTable inspection={inspection} />
    </section>
  );
}

function ColumnSelect({
  id,
  label,
  value,
  columns,
  allowEmpty,
  onChange,
}: {
  id: string;
  label: string;
  value: number | null;
  columns: { index: number; label: string }[];
  allowEmpty?: boolean;
  onChange: (value: number | null) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        id={id}
       
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
      >
        <option value="">{allowEmpty ? "Not in this file" : "Choose a column"}</option>
        {columns.map((column) => (
          <option key={column.index} value={column.index}>
            {column.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

function SampleTable({ inspection }: { inspection: ImportInspection }) {
  return (
    <div className="max-h-60 overflow-auto rounded-sm border-2 border-foreground">
      <Table className="min-w-[28rem]">
        <TableCaption className="sr-only">Header and first rows</TableCaption>
        <TableHeader className="sticky top-0 bg-card font-heading text-xs tracking-wider text-foreground uppercase">
          <TableRow>
            {inspection.columns.map((column) => (
              <TableHead key={column.index} scope="col" className="font-extrabold">
                {column.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {inspection.sampleRows.map((row, index) => (
            <TableRow key={index} className="border-t-2 border-b-0 border-dashed">
              {inspection.columns.map((column) => (
                <TableCell key={column.index} className="whitespace-nowrap">
                  {row[column.index] || ""}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

const PREVIEW_LABELS = ["Date", "Payee", "Amount", "Account", "Category", "Notes"];

function ImportPreviewTable({
  preview,
  errorsOnly,
  onToggleErrors,
}: {
  preview: ImportPreview;
  errorsOnly: boolean;
  onToggleErrors: () => void;
}) {
  const rows = errorsOnly ? preview.rows.filter((row) => row.status === "error") : preview.rows;
  const duplicates = preview.duplicateCount === 1 ? "1 duplicate" : `${preview.duplicateCount} duplicates`;
  return (
    <section aria-label="Import preview" data-import-preview className="space-y-2">
      <p data-import-summary className="text-sm">
        <span className="font-medium text-primary">{preview.readyCount} ready</span>
        <span className="text-muted-foreground">, </span>
        <span className={preview.errorCount > 0 ? "font-medium text-destructive" : "text-muted-foreground"}>
          {preview.errorCount} with errors
        </span>
        <span className="text-muted-foreground">, {duplicates}</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant={errorsOnly ? "default" : "outline"} aria-pressed={errorsOnly} onClick={onToggleErrors}>
          {errorsOnly ? "Showing error rows" : "Show error rows"}
        </Button>
        {preview.errorCount > 0 ? (
          <p className="text-sm text-muted-foreground">Rows with errors are left out. Change the columns to try again.</p>
        ) : null}
      </div>
      {errorsOnly && rows.length === 0 ? <p className="text-sm text-muted-foreground">No rows with errors.</p> : null}
      <ol aria-label="Mapped CSV rows" className="m-0 list-none space-y-3 p-0 md:hidden">
        {rows.map((row) => (
          <ImportRowCard key={row.line} row={row} labels={PREVIEW_LABELS} />
        ))}
      </ol>
      <div className="hidden max-h-96 overflow-auto rounded-sm border-2 border-foreground md:block">
        <Table className="min-w-[40rem]">
          <TableCaption className="sr-only">Mapped CSV rows</TableCaption>
          <TableHeader className="sticky top-0 bg-card font-heading text-xs tracking-wider text-foreground uppercase">
            <TableRow>
              {[...PREVIEW_LABELS, "Status"].map((label) => (
                <TableHead key={label} scope="col" className="font-extrabold">
                  {label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.line} className="border-t-2 border-b-0 border-dashed">
                {row.cells.map((cell) => (
                  <TableCell
                    key={cell.field}
                    className={cell.message ? "border-2 border-destructive bg-error-tint font-medium text-destructive" : undefined}
                  >
                    <div className="whitespace-nowrap">{cell.text || (cell.message ? "" : "—")}</div>
                    {cell.message ? <p className="mt-1 max-w-xs text-xs whitespace-normal">{cell.message}</p> : null}
                  </TableCell>
                ))}
                <TableCell className="whitespace-nowrap">
                  {row.status === "ready" ? (
                    <>
                      <StatusPill status="ready" />
                      {row.possibleTransfer ? (
                        <p className="mt-1 max-w-[14rem] text-xs whitespace-normal text-muted-foreground">
                          Looks like a transfer or card payment. {row.possibleTransfer}
                        </p>
                      ) : null}
                    </>
                  ) : row.status === "error" ? (
                    <StatusPill status="error" />
                  ) : (
                    <span className="text-muted-foreground">
                      {row.duplicateOf === "bank" ? "Already synced from bank" : "Duplicate"}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function OpenImports({ batches, undoneNotice }: { batches: OpenCsvImport[]; undoneNotice: string }) {
  const [state, action, pending] = useActionState(undoCsvImportAction, undoInitial);
  useActionToast(state, (s) => s.message || "Import undone.");
  const notice = state.message || undoneNotice;
  if (batches.length === 0 && !notice && !state.error) return null;
  return (
    <section aria-label="Imports you can undo" className="space-y-3">
      <div>
        <h2 className="font-heading text-lg font-extrabold">Imports you can undo</h2>
        <p className="text-sm text-muted-foreground">
          Undo removes only the transactions that import added, including ones you had deleted from that import. You
          can import that file again afterwards. Payee rules, transactions you entered yourself, and other imports stay
          as they are.
        </p>
      </div>
      {state.error ? (
        <FieldError>
          {state.error}
        </FieldError>
      ) : null}
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
      {batches.length > 0 ? (
        <ul className="divide-y-2 divide-dashed divide-border-soft">
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
      <Button type="submit" variant="outline" disabled={pending}>
        {pending ? "Undoing" : "Undo import"}
      </Button>
    </form>
  );
}
