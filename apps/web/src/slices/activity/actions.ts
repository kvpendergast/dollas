"use server";

import { revalidatePath } from "next/cache";
import { requireBooks } from "@/slices/access/guard";
import { parseDollarInput } from "@dollas/domain";
import { readTransactionDraft } from "./draft";
import { createHouseholdTransfer } from "./transfer-service";
import {
  amendHouseholdTransaction,
  createHouseholdTransaction,
  deleteHouseholdTransaction,
  restoreHouseholdTransaction,
  separateBankMatch,
} from "./transactions";

/** Thin form wrappers. The logic is in ./transactions, which MCP tools call too. */

function revalidateBooks() {
  revalidatePath("/activity");
  revalidatePath("/");
  revalidatePath("/plan");
  revalidatePath("/history");
  revalidatePath("/estimate");
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

export async function createTransferAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const amount = parseDollarInput(String(formData.get("amount") ?? ""));
  if (amount.isErr()) return { error: amount.error.message };
  return done(
    await createHouseholdTransfer(books, {
      fromAccountId: String(formData.get("fromAccountId") ?? ""),
      toAccountId: String(formData.get("toAccountId") ?? ""),
      amountCents: amount.value,
      occurredOn: String(formData.get("occurredOn") ?? ""),
    }),
  );
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

export async function separateBankMatchAction(transactionId: string): Promise<{ error: string }> {
  const books = await requireBooks();
  return done(await separateBankMatch(books, transactionId));
}
