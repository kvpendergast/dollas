"use server";

import { revalidatePath } from "next/cache";
import { requireBooks } from "@/slices/access/guard";
import {
  addHouseholdAccount,
  archiveHouseholdAccount,
  deleteHouseholdAccount,
  unarchiveHouseholdAccount,
  updateHouseholdAccount,
} from "@/slices/accounts/service";

/** Thin form wrappers. The logic is in ./service, which MCP tools call too. */

function revalidateAccountViews() {
  revalidatePath("/accounts");
  revalidatePath("/");
  revalidatePath("/activity");
}

function owedFromForm(formData: FormData): boolean {
  return String(formData.get("owed") ?? "") === "yes";
}

function done(result: { ok: true } | { ok: false; memberMessage: string }) {
  if (!result.ok) return { error: result.memberMessage };
  revalidateAccountViews();
  return { error: "" };
}

export async function createAccountAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  return done(
    await addHouseholdAccount(books, {
      name: String(formData.get("name") ?? ""),
      type: String(formData.get("type") ?? ""),
      opening: String(formData.get("opening") ?? "0"),
      owed: owedFromForm(formData),
    }),
  );
}

export async function updateAccountAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  return done(
    await updateHouseholdAccount(books, String(formData.get("accountId") ?? ""), {
      name: String(formData.get("name") ?? ""),
      opening: String(formData.get("opening") ?? ""),
      owed: owedFromForm(formData),
    }),
  );
}

export async function archiveAccountAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  return done(await archiveHouseholdAccount(books, String(formData.get("accountId") ?? "")));
}

export async function unarchiveAccountAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  return done(await unarchiveHouseholdAccount(books, String(formData.get("accountId") ?? "")));
}

export async function deleteAccountAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  if (String(formData.get("confirm") ?? "") !== "yes") {
    return { error: "Confirm before deleting this account." };
  }
  return done(await deleteHouseholdAccount(books, String(formData.get("accountId") ?? "")));
}
