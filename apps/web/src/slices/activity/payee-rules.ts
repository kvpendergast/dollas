"use server";

import { definePayeeCategoryRule, payeeRuleKey } from "@dollas/domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withActor } from "@/db/actor";
import { category, payeeCategoryRule } from "@/db/schema";
import { logError } from "@/lib/telemetry";
import { requireBooks } from "@/slices/access/guard";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const KNOWN = new Set([
  "Choose a category in this household.",
  "That payee match is already a rule.",
  "That payee rule is not in this household.",
]);

function isUniqueViolation(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") return true;
  return error instanceof Error && error.cause != null && isUniqueViolation(error.cause);
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(" ");
}

function ruleFailure(error: unknown, fallback: string): string {
  if (error instanceof Error && KNOWN.has(error.message)) return error.message;
  if (errorText(error).includes("payee rule category must belong to the same household")) {
    return "Choose a category in this household.";
  }
  if (isUniqueViolation(error)) return "That payee match is already a rule.";
  return fallback;
}

async function writePayeeRule(
  input: { pattern: string; categoryId: string },
  ruleId?: string,
): Promise<{ error: string }> {
  const books = await requireBooks();
  const defined = definePayeeCategoryRule(input);
  if (defined.isErr()) return { error: defined.error.message };
  if (!ID.test(defined.value.categoryId)) return { error: "Choose a category in this household." };
  if (ruleId && !ID.test(ruleId)) return { error: "That payee rule is not in this household." };

  try {
    await withActor(books.userId, async (tx) => {
      const [categoryRow] = await tx
        .select({ id: category.id })
        .from(category)
        .where(and(eq(category.id, defined.value.categoryId), eq(category.householdId, books.householdId)));
      if (!categoryRow) throw new Error("Choose a category in this household.");

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
      if (updated.length === 0) throw new Error("That payee rule is not in this household.");
    });
  } catch (error) {
    const message = ruleFailure(error, ruleId ? "Could not save that payee rule." : "Could not add that payee rule.");
    if (message === "Could not save that payee rule." || message === "Could not add that payee rule.") {
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
  if (!ID.test(ruleId)) return { error: "That payee rule is not in this household." };
  try {
    await withActor(books.userId, async (tx) => {
      const removed = await tx
        .delete(payeeCategoryRule)
        .where(and(eq(payeeCategoryRule.id, ruleId), eq(payeeCategoryRule.householdId, books.householdId)))
        .returning({ id: payeeCategoryRule.id });
      if (removed.length === 0) throw new Error("That payee rule is not in this household.");
    });
  } catch (error) {
    const message = ruleFailure(error, "Could not remove that payee rule.");
    if (message === "Could not remove that payee rule.") {
      logError(error, { action: "delete-payee-rule", householdId: books.householdId, ruleId });
    }
    return { error: message };
  }
  revalidatePath("/activity");
  return { error: "" };
}
