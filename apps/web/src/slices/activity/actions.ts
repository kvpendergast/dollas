"use server";

import { parseDollarInput, validateSplits } from "@dollas/domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withActor } from "@/db/actor";
import { category, ledgerAccount, transaction, transactionSplit } from "@/db/schema";
import { logError } from "@/lib/telemetry";
import { requireBooks } from "@/slices/access/guard";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function createTransactionAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const payee = String(formData.get("payee") ?? "").trim();
  const occurredOn = String(formData.get("occurredOn") ?? "");
  const accountId = String(formData.get("accountId") ?? "");
  const direction = String(formData.get("direction") ?? "expense") === "income" ? 1 : -1;
  const amount = parseDollarInput(String(formData.get("amount") ?? ""));
  const categoryIds = formData.getAll("categoryId").map(String).filter(Boolean);
  const splitAmounts = formData.getAll("splitAmount").map(String);
  if (payee.length < 1) return { error: "Enter a payee." };
  if (!ISO_DATE.test(occurredOn)) return { error: "Choose a date." };
  if (amount.isErr()) return { error: amount.error.message };
  if (amount.value <= 0) return { error: "Enter an amount greater than zero." };
  const total = amount.value * direction;
  const drafts =
    categoryIds.length <= 1
      ? [{ categoryId: categoryIds[0] ?? "", amountCents: total }]
      : categoryIds.map((categoryId, index) => {
          const parsed = parseDollarInput(splitAmounts[index] ?? "");
          return {
            categoryId,
            amountCents: parsed.isOk() ? parsed.value * direction : Number.NaN,
          };
        });
  const balanced = validateSplits(total, drafts);
  if (balanced.isErr()) return { error: balanced.error.message };

  try {
    await withActor(books.userId, async (tx) => {
      const [accountRow] = await tx
        .select({ id: ledgerAccount.id })
        .from(ledgerAccount)
        .where(and(eq(ledgerAccount.id, accountId), eq(ledgerAccount.householdId, books.householdId)));
      if (!accountRow) throw new Error("Choose an account in this household.");
      const known = await tx
        .select({ id: category.id })
        .from(category)
        .where(eq(category.householdId, books.householdId));
      const knownIds = new Set(known.map((row) => row.id));
      if (balanced.value.some((split) => !knownIds.has(split.categoryId))) {
        throw new Error("Choose categories from this household.");
      }
      const [row] = await tx
        .insert(transaction)
        .values({
          householdId: books.householdId,
          accountId,
          occurredOn,
          payee,
          amountCents: total,
        })
        .returning();
      await tx.insert(transactionSplit).values(
        balanced.value.map((split) => ({
          transactionId: row.id,
          householdId: books.householdId,
          categoryId: split.categoryId,
          amountCents: split.amountCents,
        })),
      );
    });
  } catch (error) {
    logError(error, { action: "create-transaction", householdId: books.householdId });
    return { error: error instanceof Error ? error.message : "Could not save that transaction." };
  }
  revalidatePath("/activity");
  revalidatePath("/");
  revalidatePath("/plan");
  revalidatePath("/history");
  revalidatePath("/projection");
  return { error: "" };
}
