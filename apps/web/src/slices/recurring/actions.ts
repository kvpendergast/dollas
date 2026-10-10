"use server";

import { toIsoDate } from "@dollas/domain";
import { revalidatePath } from "next/cache";
import { requireBooks } from "@/slices/access/guard";
import { readRecurringForm } from "./form";
import {
  createRecurringItem,
  deleteRecurringItem,
  linkRecurringTransaction,
  setRecurringItemPaused,
  unlinkRecurringTransaction,
  updateRecurringItem,
} from "./service";

/** Thin wrappers for the Recurring page and Activity. The logic is in ./service, which MCP tools call too. */

export type RecurringFormState = { error: string; message: string; savedId?: string };

function revalidateRecurring() {
  revalidatePath("/recurring", "layout");
  revalidatePath("/activity");
}

function linkedCopy(linked: number): string {
  if (linked === 0) return "";
  return ` Linked ${linked} matching transaction${linked === 1 ? "" : "s"}.`;
}

export async function createRecurringItemAction(_state: RecurringFormState, formData: FormData): Promise<RecurringFormState> {
  const books = await requireBooks();
  const parsed = readRecurringForm(formData);
  if ("error" in parsed) return { error: parsed.error, message: "" };
  const result = await createRecurringItem(books, parsed.input, toIsoDate(books.asOf));
  if (!result.ok) return { error: result.memberMessage, message: "" };
  revalidateRecurring();
  return { error: "", message: `Added ${result.value.name}.${linkedCopy(result.value.linked)}`, savedId: result.value.id };
}

export async function updateRecurringItemAction(_state: RecurringFormState, formData: FormData): Promise<RecurringFormState> {
  const books = await requireBooks();
  const parsed = readRecurringForm(formData);
  if ("error" in parsed) return { error: parsed.error, message: "" };
  const result = await updateRecurringItem(books, String(formData.get("itemId") ?? ""), parsed.input, toIsoDate(books.asOf));
  if (!result.ok) return { error: result.memberMessage, message: "" };
  revalidateRecurring();
  return { error: "", message: `Saved ${result.value.name}.${linkedCopy(result.value.linked)}`, savedId: result.value.id };
}

export async function setRecurringPausedAction(itemId: string, paused: boolean): Promise<{ error: string }> {
  const books = await requireBooks();
  const result = await setRecurringItemPaused(books, itemId, paused, toIsoDate(books.asOf));
  if (!result.ok) return { error: result.memberMessage };
  revalidateRecurring();
  return { error: "" };
}

export async function deleteRecurringItemAction(itemId: string): Promise<{ error: string }> {
  const books = await requireBooks();
  const result = await deleteRecurringItem(books, itemId);
  if (!result.ok) return { error: result.memberMessage };
  revalidateRecurring();
  return { error: "" };
}

export async function linkRecurringTransactionAction(itemId: string, transactionId: string): Promise<{ error: string }> {
  const books = await requireBooks();
  const result = await linkRecurringTransaction(books, itemId, transactionId);
  if (!result.ok) return { error: result.memberMessage };
  revalidateRecurring();
  return { error: "" };
}

export async function unlinkRecurringTransactionAction(transactionId: string): Promise<{ error: string }> {
  const books = await requireBooks();
  const result = await unlinkRecurringTransaction(books, transactionId);
  if (!result.ok) return { error: result.memberMessage };
  revalidateRecurring();
  return { error: "" };
}
