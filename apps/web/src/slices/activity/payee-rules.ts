"use server";

import { revalidatePath } from "next/cache";
import { requireBooks } from "@/slices/access/guard";
import { applyPayeeRule, deletePayeeRule, previewPayeeRuleApply, savePayeeRule } from "./payee-rule-service";

/** Thin wrappers. The logic is in ./payee-rule-service, which MCP tools call too. */

function revalidateMoney() {
  revalidatePath("/activity");
  revalidatePath("/");
  revalidatePath("/plan");
  revalidatePath("/history");
  revalidatePath("/estimate");
}

function ruleInput(formData: FormData) {
  return { pattern: String(formData.get("pattern") ?? ""), categoryId: String(formData.get("categoryId") ?? "") };
}

export async function createPayeeRuleAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const saved = await savePayeeRule(books, ruleInput(formData));
  if (!saved.ok) return { error: saved.memberMessage };
  revalidatePath("/activity");
  return { error: "" };
}

export async function updatePayeeRuleAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const saved = await savePayeeRule(books, ruleInput(formData), String(formData.get("ruleId") ?? ""));
  if (!saved.ok) return { error: saved.memberMessage };
  revalidatePath("/activity");
  return { error: "" };
}

export async function deletePayeeRuleAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const removed = await deletePayeeRule(books, String(formData.get("ruleId") ?? ""));
  if (!removed.ok) return { error: removed.memberMessage };
  revalidatePath("/activity");
  return { error: "" };
}

export type PayeeRuleApplyPreview = {
  error: string;
  pattern: string;
  categoryName: string;
  changeCount: number;
  skippedSplitCount: number;
  skippedWithoutCategoryCount: number;
};

/** How many existing transactions this saved rule would change. Does not write. */
export async function previewPayeeRuleApplyAction(ruleId: string): Promise<PayeeRuleApplyPreview> {
  const books = await requireBooks();
  const preview = await previewPayeeRuleApply(books, ruleId);
  if (!preview.ok) {
    return { error: preview.memberMessage, pattern: "", categoryName: "", changeCount: 0, skippedSplitCount: 0, skippedWithoutCategoryCount: 0 };
  }
  return { error: "", ...preview.value };
}

export type PayeeRuleApplyResult = { error: string; message: string };

export async function applyPayeeRuleAction(ruleId: string): Promise<PayeeRuleApplyResult> {
  const books = await requireBooks();
  const applied = await applyPayeeRule(books, ruleId);
  if (!applied.ok) return { error: applied.memberMessage, message: "" };
  revalidateMoney();
  return { error: "", message: applied.value.message };
}
