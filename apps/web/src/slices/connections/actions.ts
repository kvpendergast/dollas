"use server";

import { revalidatePath } from "next/cache";
import { requireBooks } from "@/slices/access/guard";
import { memberBankMessage } from "./messages";
import {
  createPlaidLinkToken,
  linkSimpleFinConnection,
  disconnectBankConnection,
  exchangePlaidPublicToken,
  syncBankConnection,
  syncMessage,
  type BankServiceResult,
} from "./service";

export type BankFormState = { error: string; message: string };

export async function linkSimpleFinAction(_state: BankFormState, formData: FormData): Promise<BankFormState> {
  const books = await requireBooks();
  const linked = await linkSimpleFinConnection(books, {
    token: String(formData.get("token") ?? ""),
    label: String(formData.get("label") ?? ""),
    sinceRaw: String(formData.get("since") ?? ""),
  });
  if (!linked.ok) return { error: shown(linked, "Could not link that bank."), message: "" };
  revalidateBooks();
  return { error: "", message: "SimpleFIN is linked. Sync to bring in accounts and transactions." };
}

export async function syncBankConnectionAction(_state: BankFormState, formData: FormData): Promise<BankFormState> {
  const books = await requireBooks();
  const connectionId = String(formData.get("connectionId") ?? "");
  const outcome = await syncBankConnection(books, connectionId);
  if (!outcome.ok) return { error: shown(outcome, "Could not sync that bank."), message: "" };
  revalidateBooks();
  return { error: "", message: syncMessage(outcome.value) };
}

export async function disconnectBankConnectionAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const connectionId = String(formData.get("connectionId") ?? "");
  const outcome = await disconnectBankConnection(books, connectionId);
  if (!outcome.ok) return { error: shown(outcome, "Could not disconnect that bank.") };
  revalidatePath("/accounts");
  return { error: "" };
}

export async function createPlaidLinkTokenAction(sinceRaw: string): Promise<{ error: string; linkToken: string }> {
  const books = await requireBooks();
  const created = await createPlaidLinkToken(books, sinceRaw);
  if (!created.ok) return { error: shown(created, "Could not link that bank."), linkToken: "" };
  return { error: "", linkToken: created.value.linkToken };
}

export async function linkPlaidAction(publicToken: string, label: string, sinceRaw: string): Promise<BankFormState> {
  const books = await requireBooks();
  const linked = await exchangePlaidPublicToken(books, publicToken, label, sinceRaw);
  if (!linked.ok) return { error: shown(linked, "Could not link that bank."), message: "" };
  revalidateBooks();
  return { error: "", message: "Plaid is linked. Sync to bring in accounts and transactions." };
}

function shown(outcome: Extract<BankServiceResult<unknown>, { ok: false }>, fallback: string): string {
  return outcome.memberMessage ?? memberBankMessage(outcome.error, fallback);
}

function revalidateBooks() {
  revalidatePath("/accounts");
  revalidatePath("/activity");
  revalidatePath("/");
  revalidatePath("/plan");
  revalidatePath("/history");
  revalidatePath("/projection");
}
