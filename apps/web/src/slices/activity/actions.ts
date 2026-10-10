"use server";

import { revalidatePath } from "next/cache";
import { requireBooks } from "@/slices/access/guard";
import { readTransactionDraft } from "./draft";
import {
  amendHouseholdTransaction,
  createHouseholdTransaction,
  deleteHouseholdTransaction,
  restoreHouseholdTransaction,
} from "./transactions";

/** Thin form wrappers. The logic is in ./transactions, which MCP tools call too. */

function revalidateBooks() {
  revalidatePath("/activity");
  revalidatePath("/");
  revalidatePath("/plan");
  revalidatePath("/history");
  revalidatePath("/projection");
}

function done(result: { ok: true } | { ok: false; memberMessage: string }) {
  if (!result.ok) return { error: result.memberMessage };
  revalidateBooks();
  return { error: "" };
}

export async function createTransactionAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const parsed = readTransactionDraft(formData);
  if ("error" in parsed) return { error: parsed.error };
  return done(await createHouseholdTransaction(books, parsed.draft));
}

export async function updateTransactionAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const parsed = readTransactionDraft(formData);
  if ("error" in parsed) return { error: parsed.error };
  return done(await amendHouseholdTransaction(books, String(formData.get("transactionId") ?? ""), parsed.draft));
}

export async function deleteTransactionAction(transactionId: string): Promise<{ error: string }> {
  const books = await requireBooks();
  return done(await deleteHouseholdTransaction(books, transactionId));
}

export async function restoreTransactionAction(transactionId: string): Promise<{ error: string }> {
  const books = await requireBooks();
  return done(await restoreHouseholdTransaction(books, transactionId));
}
