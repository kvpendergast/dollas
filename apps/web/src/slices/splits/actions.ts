"use server";

import { revalidatePath } from "next/cache";
import { requireBooks } from "@/slices/access/guard";
import { depositChoices, linkTransfer, unlinkTransfer, type DepositChoice } from "./pairs";
import { createSplit, splitDifferenceOf, unsplitTransaction, updateSplit, type SplitLineInput } from "./service";

/** Thin wrappers for the Activity split editor. The logic is in ./service, which MCP tools call too. */

export type SplitActionState = { error: string; differenceCents: number | null };

function revalidateBooks() {
  for (const path of ["/activity", "/", "/plan", "/history", "/history/profit-and-loss", "/estimate", "/accounts", "/recurring"]) revalidatePath(path);
}

export async function saveSplitAction(input: { transactionId: string; editing: boolean; lines: SplitLineInput[] }): Promise<SplitActionState> {
  const books = await requireBooks();
  const lines = Array.isArray(input.lines) ? input.lines : [];
  const result = input.editing
    ? await updateSplit(books, { transactionId: String(input.transactionId ?? ""), lines })
    : await createSplit(books, { transactionId: String(input.transactionId ?? ""), lines });
  if (!result.ok) return { error: result.memberMessage, differenceCents: splitDifferenceOf(result) };
  revalidateBooks();
  return { error: "", differenceCents: null };
}

export async function unsplitAction(transactionId: string): Promise<{ error: string }> {
  const books = await requireBooks();
  const result = await unsplitTransaction(books, String(transactionId ?? ""));
  if (!result.ok) return { error: result.memberMessage };
  revalidateBooks();
  return { error: "" };
}

/** The editor's "Existing deposit" choices for a paycheck (PEN-349). Read-only. */
export async function depositChoicesAction(transactionId: string): Promise<{ error: string; choices: DepositChoice[] }> {
  const books = await requireBooks();
  const result = await depositChoices(books, String(transactionId ?? ""));
  return result.ok ? { error: "", choices: result.value } : { error: result.memberMessage, choices: [] };
}

export async function linkTransferAction(lineTransactionId: string, depositTransactionId: string): Promise<{ error: string }> {
  const books = await requireBooks();
  const result = await linkTransfer(books, { lineTransactionId: String(lineTransactionId ?? ""), depositTransactionId: String(depositTransactionId ?? "") });
  if (!result.ok) return { error: result.memberMessage };
  revalidateBooks();
  return { error: "" };
}

export async function unlinkTransferAction(transactionId: string): Promise<{ error: string }> {
  const books = await requireBooks();
  const result = await unlinkTransfer(books, String(transactionId ?? ""));
  if (!result.ok) return { error: result.memberMessage };
  revalidateBooks();
  return { error: "" };
}
