"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { importCsvAction } from "@/slices/activity/actions";

const initial = { error: "", message: "" };

export function ImportForm() {
  const [state, action, pending] = useActionState(importCsvAction, initial);
  return (
    <form action={action} className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Columns are date, payee, amount, account, and category. Amounts are dollars and cents. Negative amounts are
        expenses and positive amounts are income. Account and category names have to match this household.
      </p>
      <pre className="overflow-x-auto rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{`date,payee,amount,account,category
2026-03-02,Market,-86.40,Checking,Groceries`}</pre>
      <div className="space-y-1.5">
        <Label htmlFor="csv-file">CSV file</Label>
        <Input id="csv-file" name="csv" type="file" accept=".csv,text/csv" required />
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
      <Button type="submit" className="h-10" disabled={pending}>
        {pending ? "Importing" : "Import CSV"}
      </Button>
    </form>
  );
}
