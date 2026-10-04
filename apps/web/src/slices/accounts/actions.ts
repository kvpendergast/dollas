"use server";

import { parseDollarInput } from "@dollas/domain";
import { revalidatePath } from "next/cache";
import { ledgerAccount } from "@/db/schema";
import { withActor } from "@/db/actor";
import { logError } from "@/lib/telemetry";
import { requireBooks } from "@/slices/access/guard";

const ACCOUNT_TYPES = new Set(["checking", "savings", "credit", "cash"]);

export async function createAccountAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const name = String(formData.get("name") ?? "").trim();
  const type = String(formData.get("type") ?? "");
  const parsed = parseDollarInput(String(formData.get("opening") ?? "0"));
  if (name.length < 2) return { error: "Name the account." };
  if (!ACCOUNT_TYPES.has(type)) return { error: "Choose an account type." };
  if (parsed.isErr()) return { error: parsed.error.message };
  try {
    await withActor(books.userId, (tx) =>
      tx.insert(ledgerAccount).values({
        householdId: books.householdId,
        name,
        type,
        openingBalanceCents: parsed.value,
      }),
    );
  } catch (error) {
    logError(error, { action: "create-account", householdId: books.householdId });
    return { error: "Could not add that account." };
  }
  revalidatePath("/accounts");
  revalidatePath("/");
  return { error: "" };
}
