"use server";

import { decideBudgetAmount, formatBudgetMonth, memberFacingMessage, parseBudgetMonth } from "@dollas/domain";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireBooks } from "@/slices/access/guard";
import { clearBudget, copyLastMonth, setBudget } from "./service";

/** Thin form wrappers. The logic is in ./service, which MCP tools call too. */

const SAVE_FALLBACK = "Could not save that budget.";
const COPY_FALLBACK = "Could not copy last month's budgets.";

export async function setBudgetAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const month = parseBudgetMonth(String(formData.get("month") ?? ""));
  if (month.isErr()) return { error: memberFacingMessage(month.error, SAVE_FALLBACK) };
  const decision =
    String(formData.get("intent") ?? "") === "clear"
      ? decideBudgetAmount("")
      : decideBudgetAmount(String(formData.get("amount") ?? ""));
  if (decision.isErr()) return { error: memberFacingMessage(decision.error, SAVE_FALLBACK) };
  const categoryId = String(formData.get("categoryId") ?? "");
  const result =
    decision.value.action === "clear"
      ? await clearBudget(books, { categoryId, month: month.value })
      : await setBudget(books, { categoryId, month: month.value, amountCents: decision.value.amountCents });
  if (!result.ok) return { error: result.memberMessage };
  revalidatePath("/plan");
  revalidatePath("/");
  revalidatePath("/estimate");
  return { error: "" };
}

export async function copyPreviousMonthAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const month = parseBudgetMonth(String(formData.get("month") ?? ""));
  if (month.isErr()) return { error: memberFacingMessage(month.error, COPY_FALLBACK) };
  const copied = await copyLastMonth(books, { month: month.value, overwrite: String(formData.get("overwrite") ?? "") === "yes" });
  if (!copied.ok) return { error: copied.memberMessage };
  revalidatePath("/plan");
  revalidatePath("/");
  revalidatePath("/estimate");
  redirect(`/plan?month=${formatBudgetMonth(month.value)}`);
}
