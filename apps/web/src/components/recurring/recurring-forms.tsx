"use client";

import { CADENCES, CADENCE_LABELS, categoryMenuSections, type CategoryMenuEntry } from "@dollas/domain";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createRecurringItemAction,
  deleteRecurringItemAction,
  linkRecurringTransactionAction,
  setRecurringPausedAction,
  unlinkRecurringTransactionAction,
  updateRecurringItemAction,
  type RecurringFormState,
} from "@/slices/recurring/actions";

const selectClass = "h-10 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm";

export type RecurringFormValues = {
  id?: string;
  name: string;
  payeeMatch: string;
  amountCents: number;
  cadence: string;
  anchorDate: string;
  dayOfMonth: number | null;
  secondDayOfMonth: number | null;
  categoryId: string | null;
  accountId: string | null;
  tolerancePercent: number;
  toleranceCents: number;
  windowDays: number;
  startDate: string | null;
  endDate: string | null;
};

type AccountChoice = { id: string; name: string };

function dollars(cents: number): string {
  const abs = Math.abs(cents);
  return `${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Create or edit a recurring item. The service validates; this only collects. */
export function RecurringItemForm({
  values,
  categories,
  accounts,
  submitLabel,
}: {
  values: RecurringFormValues;
  categories: CategoryMenuEntry[];
  accounts: AccountChoice[];
  submitLabel: string;
}) {
  const editing = Boolean(values.id);
  const [state, action, pending] = useActionState<RecurringFormState, FormData>(
    editing ? updateRecurringItemAction : createRecurringItemAction,
    { error: "", message: "" },
  );
  const [cadence, setCadence] = useState(values.cadence);
  const field = `recurring-${values.id ?? "new"}`;
  const menu = categoryMenuSections(categories);
  const monthly = cadence !== "weekly" && cadence !== "biweekly";

  return (
    <form key={editing ? "edit" : (state.savedId ?? "new")} action={action} className="space-y-4" aria-label={editing ? `Edit ${values.name}` : "New recurring item"}>
      {values.id ? <input type="hidden" name="itemId" value={values.id} /> : null}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${field}-name`}>Name</Label>
          <Input id={`${field}-name`} name="name" className="h-10" defaultValue={values.name} placeholder="Rent" required />
        </div>
        <div className="grid grid-cols-[8rem_1fr] gap-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${field}-direction`}>Type</Label>
            <select id={`${field}-direction`} name="direction" className={selectClass} defaultValue={values.amountCents > 0 ? "income" : "expense"}>
              <option value="expense">Bill</option>
              <option value="income">Income</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${field}-amount`}>Expected amount</Label>
            <Input
              id={`${field}-amount`}
              name="amount"
              className="h-10 tabular-nums"
              inputMode="decimal"
              defaultValue={values.amountCents === 0 ? "" : dollars(values.amountCents)}
              placeholder="0.00"
              required
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${field}-cadence`}>How often</Label>
          <select
            id={`${field}-cadence`}
            name="cadence"
            className={selectClass}
            value={cadence}
            onChange={(event) => setCadence(event.target.value)}
          >
            {CADENCES.map((value) => (
              <option key={value} value={value}>
                {CADENCE_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className={`grid gap-3 ${cadence === "semimonthly" ? "grid-cols-[1fr_7rem]" : ""}`}>
          <div className="space-y-1.5">
            <Label htmlFor={`${field}-anchor`}>{monthly ? "Next or last due date" : "One due date"}</Label>
            <Input id={`${field}-anchor`} name="anchorDate" type="date" className="h-10" defaultValue={values.anchorDate} required />
          </div>
          {cadence === "semimonthly" ? (
            <div className="space-y-1.5">
              <Label htmlFor={`${field}-second`}>Also on day</Label>
              <Input
                id={`${field}-second`}
                name="secondDayOfMonth"
                type="number"
                min={1}
                max={31}
                className="h-10"
                defaultValue={values.secondDayOfMonth ?? ""}
                required
              />
            </div>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${field}-category`}>Category (optional)</Label>
          <select id={`${field}-category`} name="categoryId" className={selectClass} defaultValue={values.categoryId ?? ""}>
            <option value="">None</option>
            {menu.isOk()
              ? menu.value.map((section) => (
                  <optgroup key={section.id} label={section.label}>
                    {section.items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </optgroup>
                ))
              : null}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${field}-account`}>Account (optional)</Label>
          <select id={`${field}-account`} name="accountId" className={selectClass} defaultValue={values.accountId ?? ""}>
            <option value="">Any account</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <details className="rounded-lg border border-border px-3 py-2">
        <summary className="cursor-pointer text-sm text-muted-foreground">Matching and dates</summary>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <div className="space-y-1.5 md:col-span-3">
            <Label htmlFor={`${field}-payee`}>Payee contains</Label>
            <Input id={`${field}-payee`} name="payeeMatch" className="h-10" defaultValue={values.payeeMatch} placeholder="Defaults to the name" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${field}-percent`}>Amount within ± %</Label>
            <Input id={`${field}-percent`} name="tolerancePercent" type="number" min={0} max={50} className="h-10" defaultValue={values.tolerancePercent} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${field}-range`}>or within ± $</Label>
            <Input
              id={`${field}-range`}
              name="toleranceAmount"
              inputMode="decimal"
              className="h-10"
              defaultValue={values.toleranceCents === 0 ? "" : dollars(values.toleranceCents)}
              placeholder="0.00"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${field}-window`}>Date within ± days</Label>
            <Input id={`${field}-window`} name="windowDays" type="number" min={0} max={10} className="h-10" defaultValue={values.windowDays} />
          </div>
          {monthly ? (
            <div className="space-y-1.5">
              <Label htmlFor={`${field}-day`}>Day of month</Label>
              <Input
                id={`${field}-day`}
                name="dayOfMonth"
                type="number"
                min={1}
                max={31}
                className="h-10"
                defaultValue={values.dayOfMonth ?? ""}
                placeholder="From the date"
              />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor={`${field}-start`}>Starts (optional)</Label>
            <Input id={`${field}-start`} name="startDate" type="date" className="h-10" defaultValue={values.startDate ?? ""} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${field}-end`}>Ends (optional)</Label>
            <Input id={`${field}-end`} name="endDate" type="date" className="h-10" defaultValue={values.endDate ?? ""} />
          </div>
        </div>
      </details>
      {state.error ? (
        <p role="alert" className="text-sm text-over">
          {state.error}
        </p>
      ) : state.message ? (
        <p role="status" className="text-sm text-primary">
          {state.message}
        </p>
      ) : null}
      <Button type="submit" className="h-10" disabled={pending}>
        {pending ? "Saving" : submitLabel}
      </Button>
    </form>
  );
}

/** Pause or resume, and delete with a confirm. */
export function RecurringItemControls({ itemId, name, paused }: { itemId: string; name: string; paused: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(task: () => Promise<{ error: string }>, after?: () => void) {
    setBusy(true);
    setError("");
    const result = await task();
    setBusy(false);
    if (result.error) setError(result.error);
    else after?.();
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" className="h-10" disabled={busy} onClick={() => void run(() => setRecurringPausedAction(itemId, !paused))}>
          {paused ? "Resume" : "Pause"}
        </Button>
        <Dialog>
          <DialogTrigger asChild>
            <Button type="button" variant="destructive" className="h-10" disabled={busy}>
              Delete
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete {name}?</DialogTitle>
              <DialogDescription>Linked transactions stay in your books and stand alone again.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Keep it
                </Button>
              </DialogClose>
              <Button
                type="button"
                variant="destructive"
                disabled={busy}
                onClick={() => void run(() => deleteRecurringItemAction(itemId), () => router.push("/recurring"))}
              >
                {busy ? "Deleting" : "Delete"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-over">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function UnlinkRecurringButton({ transactionId, payee }: { transactionId: string; payee: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        className="h-8 px-2 text-xs"
        disabled={busy}
        aria-label={`Unlink ${payee}`}
        onClick={async () => {
          setBusy(true);
          const result = await unlinkRecurringTransactionAction(transactionId);
          setBusy(false);
          setError(result.error);
        }}
      >
        {busy ? "Unlinking" : "Unlink"}
      </Button>
      {error ? (
        <span role="alert" className="text-xs text-over">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/** In Activity's editor: link this transaction to an item, or unlink it. */
export function RecurringLinkControl({
  transactionId,
  payee,
  recurring,
  choices,
}: {
  transactionId: string;
  payee: string;
  recurring: { id: string; name: string } | null;
  choices: Array<{ id: string; name: string }>;
}) {
  const [itemId, setItemId] = useState(choices[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const field = `recurring-link-${transactionId}`;
  if (!recurring && choices.length === 0) return null;

  async function run(task: () => Promise<{ error: string }>) {
    setBusy(true);
    setError("");
    const result = await task();
    setBusy(false);
    setError(result.error);
  }

  return (
    <div className="space-y-1.5 rounded-lg border border-border px-3 py-2">
      {recurring ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>
            Recurring:{" "}
            <Link href={`/recurring/${recurring.id}`} className="text-primary underline-offset-4 hover:underline">
              {recurring.name}
            </Link>
          </span>
          <Button
            type="button"
            variant="outline"
            className="h-10"
            disabled={busy}
            aria-label={`Unlink ${payee} from ${recurring.name}`}
            onClick={() => void run(() => unlinkRecurringTransactionAction(transactionId))}
          >
            {busy ? "Unlinking" : "Unlink"}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-48 flex-1 space-y-1.5">
            <Label htmlFor={field}>Recurring</Label>
            <select id={field} className={selectClass} value={itemId} onChange={(event) => setItemId(event.target.value)}>
              {choices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.name}
                </option>
              ))}
            </select>
          </div>
          <Button
            type="button"
            variant="outline"
            className="h-10"
            disabled={busy || !itemId}
            onClick={() => void run(() => linkRecurringTransactionAction(itemId, transactionId))}
          >
            {busy ? "Linking" : "Link"}
          </Button>
        </div>
      )}
      {error ? (
        <p role="alert" className="text-sm text-over">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** "Make recurring" from a suggestion: one tap creates the item with the suggested schedule. */
export function MakeRecurringButton({ suggestion }: { suggestion: RecurringFormValues }) {
  const [state, action, pending] = useActionState<RecurringFormState, FormData>(createRecurringItemAction, { error: "", message: "" });
  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="name" value={suggestion.name} />
      <input type="hidden" name="payeeMatch" value={suggestion.payeeMatch} />
      <input type="hidden" name="direction" value={suggestion.amountCents > 0 ? "income" : "expense"} />
      <input type="hidden" name="amount" value={dollars(suggestion.amountCents)} />
      <input type="hidden" name="cadence" value={suggestion.cadence} />
      <input type="hidden" name="anchorDate" value={suggestion.anchorDate} />
      {suggestion.secondDayOfMonth ? <input type="hidden" name="secondDayOfMonth" value={suggestion.secondDayOfMonth} /> : null}
      <input type="hidden" name="categoryId" value={suggestion.categoryId ?? ""} />
      <input type="hidden" name="accountId" value={suggestion.accountId ?? ""} />
      <input type="hidden" name="tolerancePercent" value={suggestion.tolerancePercent} />
      <Button type="submit" variant="outline" className="h-10" disabled={pending} aria-label={`Make ${suggestion.name} recurring`}>
        {pending ? "Adding" : "Make recurring"}
      </Button>
      {state.error ? (
        <p role="alert" className="text-xs text-over">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
