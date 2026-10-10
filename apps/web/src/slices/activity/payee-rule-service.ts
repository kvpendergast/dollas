import { definePayeeCategoryRule, payeeRuleKey } from "@dollas/domain";
import { and, eq } from "drizzle-orm";
import { withActor } from "@/db/actor";
import { category, categoryGroup, payeeCategoryRule } from "@/db/schema";
import { logError, logInfo } from "@/lib/telemetry";
import { UUID, refuse, succeed, type ServiceActor, type ServiceResult, type Via } from "@/lib/service-result";
import { describePayeeRuleApplied, type PayeeRuleApplyCounts } from "./payee-rule-copy";
import { PAYEE_RULE_CATEGORY, PAYEE_RULE_DUPLICATE, PAYEE_RULE_NOT_IN_HOUSEHOLD, payeeRuleMemberMessage } from "./payee-rule-plan";
import {
  applyPayeeRuleInTransaction,
  loadPayeeRuleApply,
  removePayeeRuleInTransaction,
  type LoadedPayeeRuleApply,
} from "./payee-rule-store";

/**
 * Payee rule services shared by the Activity page and MCP tools. Rules run on
 * new CSV imports and bank syncs; applying one to existing transactions is a
 * separate, previewable step.
 */

export type PayeeRule = { id: string; pattern: string; categoryId: string; categoryName: string };

function rejected(error: unknown, fallback: string, attributes: Record<string, string>): ServiceResult<never> {
  const message = payeeRuleMemberMessage(error, fallback);
  if (message === fallback) logError(error, attributes);
  return refuse(message, error);
}

export async function listPayeeRules(actor: ServiceActor): Promise<ServiceResult<PayeeRule[]>> {
  try {
    const rows = await withActor(actor.userId, (tx) =>
      tx
        .select({
          id: payeeCategoryRule.id,
          pattern: payeeCategoryRule.pattern,
          categoryId: payeeCategoryRule.categoryId,
          categoryName: category.name,
          groupName: categoryGroup.name,
        })
        .from(payeeCategoryRule)
        .innerJoin(category, eq(category.id, payeeCategoryRule.categoryId))
        .leftJoin(categoryGroup, eq(categoryGroup.id, category.groupId))
        .where(eq(payeeCategoryRule.householdId, actor.householdId)),
    );
    return succeed(
      rows
        .map((row) => ({
          id: row.id,
          pattern: row.pattern,
          categoryId: row.categoryId,
          categoryName: row.groupName ? `${row.groupName} · ${row.categoryName}` : row.categoryName,
        }))
        .sort((a, b) => a.pattern.localeCompare(b.pattern)),
    );
  } catch (error) {
    return rejected(error, "Could not load payee rules.", { action: "list-payee-rules", householdId: actor.householdId });
  }
}

/** Adds a rule, or replaces one when `ruleId` is given. One rule per payee match. */
export async function savePayeeRule(
  actor: ServiceActor,
  input: { pattern: string; categoryId: string },
  ruleId?: string,
  via: Via = "web",
): Promise<ServiceResult<{ id: string; pattern: string; categoryId: string }>> {
  const defined = definePayeeCategoryRule(input);
  if (defined.isErr()) return refuse(defined.error.message, defined.error);
  if (!UUID.test(defined.value.categoryId)) return refuse(PAYEE_RULE_CATEGORY);
  if (ruleId !== undefined && !UUID.test(ruleId)) return refuse(PAYEE_RULE_NOT_IN_HOUSEHOLD);
  const action = ruleId ? "update-payee-rule" : "create-payee-rule";
  try {
    const id = await withActor(actor.userId, async (tx) => {
      const [categoryRow] = await tx
        .select({ id: category.id })
        .from(category)
        .where(and(eq(category.id, defined.value.categoryId), eq(category.householdId, actor.householdId)));
      if (!categoryRow) throw new Error(PAYEE_RULE_CATEGORY);
      const existing = await tx
        .select({ id: payeeCategoryRule.id, pattern: payeeCategoryRule.pattern })
        .from(payeeCategoryRule)
        .where(eq(payeeCategoryRule.householdId, actor.householdId));
      const key = payeeRuleKey(defined.value.pattern);
      if (existing.some((row) => row.id !== ruleId && payeeRuleKey(row.pattern) === key)) {
        throw new Error(PAYEE_RULE_DUPLICATE);
      }
      if (!ruleId) {
        const [row] = await tx
          .insert(payeeCategoryRule)
          .values({ householdId: actor.householdId, pattern: defined.value.pattern, categoryId: defined.value.categoryId })
          .returning({ id: payeeCategoryRule.id });
        if (!row) throw new Error("payee rule insert returned no row");
        return row.id;
      }
      const updated = await tx
        .update(payeeCategoryRule)
        .set({ pattern: defined.value.pattern, categoryId: defined.value.categoryId })
        .where(and(eq(payeeCategoryRule.id, ruleId), eq(payeeCategoryRule.householdId, actor.householdId)))
        .returning({ id: payeeCategoryRule.id });
      if (updated.length === 0) throw new Error(PAYEE_RULE_NOT_IN_HOUSEHOLD);
      return ruleId;
    });
    logInfo("Payee rule saved", { action, via, householdId: actor.householdId });
    return succeed({ id, pattern: defined.value.pattern, categoryId: defined.value.categoryId });
  } catch (error) {
    return rejected(error, ruleId ? "Could not save that payee rule." : "Could not add that payee rule.", {
      action,
      via,
      householdId: actor.householdId,
    });
  }
}

export async function deletePayeeRule(
  actor: ServiceActor,
  ruleId: string,
  via: Via = "web",
): Promise<ServiceResult<{ id: string; pattern: string }>> {
  if (!UUID.test(ruleId)) return refuse(PAYEE_RULE_NOT_IN_HOUSEHOLD);
  try {
    const removed = await withActor(actor.userId, (tx) => removePayeeRuleInTransaction(tx, actor.householdId, ruleId));
    logInfo("Payee rule removed", { action: "delete-payee-rule", via, householdId: actor.householdId });
    return succeed(removed);
  } catch (error) {
    return rejected(error, "Could not remove that payee rule.", { action: "delete-payee-rule", via, householdId: actor.householdId, ruleId });
  }
}

function countsFrom(loaded: LoadedPayeeRuleApply): PayeeRuleApplyCounts {
  return {
    pattern: loaded.pattern,
    categoryName: loaded.categoryName,
    changeCount: loaded.plan.changeIds.length,
    skippedSplitCount: loaded.plan.skippedSplitIds.length,
    skippedWithoutCategoryCount: loaded.plan.skippedWithoutCategoryIds.length,
  };
}

/** How many existing transactions the saved rule would change. Does not write. */
export async function previewPayeeRuleApply(actor: ServiceActor, ruleId: string): Promise<ServiceResult<PayeeRuleApplyCounts>> {
  if (!UUID.test(ruleId)) return refuse(PAYEE_RULE_NOT_IN_HOUSEHOLD);
  try {
    const loaded = await withActor(actor.userId, (tx) => loadPayeeRuleApply(tx, actor.householdId, ruleId));
    return succeed(countsFrom(loaded));
  } catch (error) {
    return rejected(error, "Could not check that payee rule.", { action: "preview-payee-rule", householdId: actor.householdId, ruleId });
  }
}

/**
 * Applies the saved rule to existing matches in one household transaction.
 * The message reports the count from that same transaction.
 */
export async function applyPayeeRule(
  actor: ServiceActor,
  ruleId: string,
  via: Via = "web",
): Promise<ServiceResult<PayeeRuleApplyCounts & { message: string }>> {
  if (!UUID.test(ruleId)) return refuse(PAYEE_RULE_NOT_IN_HOUSEHOLD);
  try {
    const loaded = await withActor(actor.userId, (tx) => applyPayeeRuleInTransaction(tx, actor.householdId, ruleId));
    const counts = countsFrom(loaded);
    logInfo("Payee rule applied", { action: "apply-payee-rule", via, householdId: actor.householdId, changed: String(counts.changeCount) });
    return succeed({ ...counts, message: describePayeeRuleApplied(counts) });
  } catch (error) {
    return rejected(error, "Could not apply that payee rule.", { action: "apply-payee-rule", via, householdId: actor.householdId, ruleId });
  }
}
