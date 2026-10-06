"use server";

import {
  clearCategoryBudget,
  copyPreviousMonthBudgets,
  decideBudgetAmount,
  DomainError,
  formatBudgetMonth,
  memberFacingMessage,
  parseBudgetMonth,
  setCategoryBudget,
} from "@dollas/domain";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { withActor } from "@/db/actor";
import { logError } from "@/lib/telemetry";
import { requireBooks } from "@/slices/access/guard";
import { drizzleBudgetStore } from "./store";

const SAVE_FALLBACK = "Could not save that budget.";
const COPY_FALLBACK = "Could not copy last month's budgets.";

function shown(error: unknown, fallback: string): string {
  if (error instanceof DomainError) return memberFacingMessage(error, fallback);
  return fallback;
}

export async function setBudgetAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const month = parseBudgetMonth(String(formData.get("month") ?? ""));
  if (month.isErr()) return { error: shown(month.error, SAVE_FALLBACK) };
  const decision =
    String(formData.get("intent") ?? "") === "clear"
      ? decideBudgetAmount("")
      : decideBudgetAmount(String(formData.get("amount") ?? ""));
  if (decision.isErr()) return { error: shown(decision.error, SAVE_FALLBACK) };
  const categoryId = String(formData.get("categoryId") ?? "");
  try {
    const result = await withActor(books.userId, (tx) => {
      const store = drizzleBudgetStore(tx);
      if (decision.value.action === "clear") {
        return clearCategoryBudget(store, { householdId: books.householdId, categoryId, month: month.value });
      }
      return setCategoryBudget(store, {
        householdId: books.householdId,
        categoryId,
        month: month.value,
        amountCents: decision.value.amountCents,
      });
    });
    if (result.isErr()) {
      logError(result.error, { action: "set-budget", householdId: books.householdId });
      return { error: shown(result.error, SAVE_FALLBACK) };
    }
  } catch (error) {
    logError(error, { action: "set-budget", householdId: books.householdId });
    return { error: shown(error, SAVE_FALLBACK) };
  }
  revalidatePath("/plan");
  revalidatePath("/");
  return { error: "" };
}

export async function copyPreviousMonthAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const month = parseBudgetMonth(String(formData.get("month") ?? ""));
  if (month.isErr()) return { error: shown(month.error, COPY_FALLBACK) };
  try {
    const result = await withActor(books.userId, (tx) =>
      copyPreviousMonthBudgets(drizzleBudgetStore(tx), {
        householdId: books.householdId,
        month: month.value,
        confirmOverwrite: String(formData.get("overwrite") ?? "") === "yes",
      }),
    );
    if (result.isErr()) {
      logError(result.error, { action: "copy-budgets", householdId: books.householdId });
      return { error: shown(result.error, COPY_FALLBACK) };
    }
  } catch (error) {
    logError(error, { action: "copy-budgets", householdId: books.householdId });
    return { error: shown(error, COPY_FALLBACK) };
  }
  revalidatePath("/plan");
  revalidatePath("/");
  redirect(`/plan?month=${formatBudgetMonth(month.value)}`);
}
