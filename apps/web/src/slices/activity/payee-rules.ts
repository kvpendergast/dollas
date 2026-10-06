"use server";

import { definePayeeCategoryRule, payeeRuleKey } from "@dollas/domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withActor } from "@/db/actor";
import { category, payeeCategoryRule } from "@/db/schema";
import { logError } from "@/lib/telemetry";
import { requireBooks } from "@/slices/access/guard";
import { describePayeeRuleApplied, type PayeeRuleApplyCounts } from "./payee-rule-copy";
import {
  PAYEE_RULE_CATEGORY,
  PAYEE_RULE_NOT_IN_HOUSEHOLD,
  payeeRuleMemberMessage,
} from "./payee-rule-plan";
import { applyPayeeRuleInTransaction, loadPayeeRuleApply, removePayeeRuleInTransaction } from "./payee-rule-store";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function revalidateMoney() {
  revalidatePath("/activity");
  revalidatePath("/");
  revalidatePath("/plan");
  revalidatePath("/history");
  revalidatePath("/projection");
}

async function writePayeeRule(
  input: { pattern: string; categoryId: string },
  ruleId?: string,
): Promise<{ error: string }> {
  const books = await requireBooks();
  const defined = definePayeeCategoryRule(input);
  if (defined.isErr()) return { error: defined.error.message };
  if (!ID.test(defined.value.categoryId)) return { error: PAYEE_RULE_CATEGORY };
  if (ruleId && !ID.test(ruleId)) return { error: PAYEE_RULE_NOT_IN_HOUSEHOLD };

  try {
    await withActor(books.userId, async (tx) => {
      const [categoryRow] = await tx
        .select({ id: category.id })
        .from(category)
        .where(and(eq(category.id, defined.value.categoryId), eq(category.householdId, books.householdId)));
      if (!categoryRow) throw new Error(PAYEE_RULE_CATEGORY);

      const existing = await tx
        .select({ id: payeeCategoryRule.id, pattern: payeeCategoryRule.pattern })
        .from(payeeCategoryRule)
        .where(eq(payeeCategoryRule.householdId, books.householdId));
      const key = payeeRuleKey(defined.value.pattern);
      if (existing.some((row) => row.id !== ruleId && payeeRuleKey(row.pattern) === key)) {
        throw new Error("That payee match is already a rule.");
      }

      if (!ruleId) {
        await tx.insert(payeeCategoryRule).values({
          householdId: books.householdId,
          pattern: defined.value.pattern,
          categoryId: defined.value.categoryId,
        });
        return;
      }

      const updated = await tx
        .update(payeeCategoryRule)
        .set({
          pattern: defined.value.pattern,
          categoryId: defined.value.categoryId,
        })
        .where(and(eq(payeeCategoryRule.id, ruleId), eq(payeeCategoryRule.householdId, books.householdId)))
        .returning({ id: payeeCategoryRule.id });
      if (updated.length === 0) throw new Error(PAYEE_RULE_NOT_IN_HOUSEHOLD);
    });
  } catch (error) {
    const fallback = ruleId ? "Could not save that payee rule." : "Could not add that payee rule.";
    const message = payeeRuleMemberMessage(error, fallback);
    if (message === fallback) {
      logError(error, { action: ruleId ? "update-payee-rule" : "create-payee-rule", householdId: books.householdId });
    }
    return { error: message };
  }

  revalidatePath("/activity");
  return { error: "" };
}

export async function createPayeeRuleAction(_state: { error: string }, formData: FormData) {
  return writePayeeRule({
    pattern: String(formData.get("pattern") ?? ""),
    categoryId: String(formData.get("categoryId") ?? ""),
  });
}

export async function updatePayeeRuleAction(_state: { error: string }, formData: FormData) {
  return writePayeeRule(
    {
      pattern: String(formData.get("pattern") ?? ""),
      categoryId: String(formData.get("categoryId") ?? ""),
    },
    String(formData.get("ruleId") ?? ""),
  );
}

export async function deletePayeeRuleAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const ruleId = String(formData.get("ruleId") ?? "");
  if (!ID.test(ruleId)) return { error: PAYEE_RULE_NOT_IN_HOUSEHOLD };
  try {
    await withActor(books.userId, (tx) => removePayeeRuleInTransaction(tx, books.householdId, ruleId));
  } catch (error) {
    const message = payeeRuleMemberMessage(error, "Could not remove that payee rule.");
    if (message === "Could not remove that payee rule.") {
      logError(error, { action: "delete-payee-rule", householdId: books.householdId, ruleId });
    }
    return { error: message };
  }
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

const EMPTY_PREVIEW: PayeeRuleApplyPreview = {
  error: "",
  pattern: "",
  categoryName: "",
  changeCount: 0,
  skippedSplitCount: 0,
  skippedWithoutCategoryCount: 0,
};

function countsFrom(loaded: {
  pattern: string;
  categoryName: string;
  plan: { changeIds: readonly string[]; skippedSplitIds: readonly string[]; skippedWithoutCategoryIds: readonly string[] };
}): PayeeRuleApplyCounts {
  return {
    pattern: loaded.pattern,
    categoryName: loaded.categoryName,
    changeCount: loaded.plan.changeIds.length,
    skippedSplitCount: loaded.plan.skippedSplitIds.length,
    skippedWithoutCategoryCount: loaded.plan.skippedWithoutCategoryIds.length,
  };
}

/** How many existing transactions this saved rule would change. Does not write. */
export async function previewPayeeRuleApplyAction(ruleId: string): Promise<PayeeRuleApplyPreview> {
  const books = await requireBooks();
  if (!ID.test(ruleId)) return { ...EMPTY_PREVIEW, error: PAYEE_RULE_NOT_IN_HOUSEHOLD };
  try {
    const loaded = await withActor(books.userId, (tx) => loadPayeeRuleApply(tx, books.householdId, ruleId));
    return { error: "", ...countsFrom(loaded) };
  } catch (error) {
    const message = payeeRuleMemberMessage(error, "Could not check that payee rule.");
    if (message === "Could not check that payee rule.") {
      logError(error, { action: "preview-payee-rule", householdId: books.householdId, ruleId });
    }
    return { ...EMPTY_PREVIEW, error: message };
  }
}

export type PayeeRuleApplyResult = { error: string; message: string };

/**
 * Applies the saved rule to existing matches in one household transaction.
 * The message reports the count from that same transaction.
 */
export async function applyPayeeRuleAction(ruleId: string): Promise<PayeeRuleApplyResult> {
  const books = await requireBooks();
  if (!ID.test(ruleId)) return { error: PAYEE_RULE_NOT_IN_HOUSEHOLD, message: "" };
  let loaded: Awaited<ReturnType<typeof applyPayeeRuleInTransaction>>;
  try {
    loaded = await withActor(books.userId, (tx) => applyPayeeRuleInTransaction(tx, books.householdId, ruleId));
  } catch (error) {
    const message = payeeRuleMemberMessage(error, "Could not apply that payee rule.");
    if (message === "Could not apply that payee rule.") {
      logError(error, { action: "apply-payee-rule", householdId: books.householdId, ruleId });
    }
    return { error: message, message: "" };
  }
  revalidateMoney();
  return { error: "", message: describePayeeRuleApplied(countsFrom(loaded)) };
}
