"use server";

import { parseDollarInput } from "@dollas/domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withActor } from "@/db/actor";
import { category, categoryBudget } from "@/db/schema";
import { logError } from "@/lib/telemetry";
import { requireBooks } from "@/slices/access/guard";

export async function setBudgetAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const categoryId = String(formData.get("categoryId") ?? "");
  const parsed = parseDollarInput(String(formData.get("amount") ?? ""));
  if (parsed.isErr()) return { error: parsed.error.message };
  if (parsed.value < 0) return { error: "A budget cannot be negative." };
  try {
    await withActor(books.userId, async (tx) => {
      const [known] = await tx
        .select({ id: category.id })
        .from(category)
        .where(and(eq(category.id, categoryId), eq(category.householdId, books.householdId), eq(category.kind, "expense")));
      if (!known) throw new Error("That category is not in this household.");
      await tx
        .insert(categoryBudget)
        .values({
          householdId: books.householdId,
          categoryId,
          year: books.asOf.year,
          month: books.asOf.month,
          amountCents: parsed.value,
        })
        .onConflictDoUpdate({
          target: [categoryBudget.categoryId, categoryBudget.year, categoryBudget.month],
          set: { amountCents: parsed.value },
        });
    });
  } catch (error) {
    logError(error, { action: "set-budget", householdId: books.householdId });
    return { error: "Could not save that budget." };
  }
  revalidatePath("/plan");
  revalidatePath("/");
  return { error: "" };
}
