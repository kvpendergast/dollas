import { and, eq, inArray } from "drizzle-orm";
import type { AppTx } from "@/db/client";
import { category, categoryGroup, payeeCategoryRule, transaction, transactionSplit } from "@/db/schema";
import {
  planPayeeRuleApply,
  PAYEE_RULE_NOT_IN_HOUSEHOLD,
  type PayeeRuleApplyCandidate,
  type PayeeRuleApplyPlan,
} from "./payee-rule-plan";

export type LoadedPayeeRuleApply = {
  ruleId: string;
  pattern: string;
  categoryId: string;
  categoryName: string;
  plan: PayeeRuleApplyPlan;
};

function categoryLabel(name: string, groupName: string | null): string {
  return groupName ? `${groupName} · ${name}` : name;
}

/**
 * Reads the saved rule and the household's transactions, then plans the apply.
 * Call this inside `withActor` so the read uses the household role.
 */
export async function loadPayeeRuleApply(
  tx: AppTx,
  householdId: string,
  ruleId: string,
): Promise<LoadedPayeeRuleApply> {
  const [rule] = await tx
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
    .where(and(eq(payeeCategoryRule.id, ruleId), eq(payeeCategoryRule.householdId, householdId)));
  if (!rule) throw new Error(PAYEE_RULE_NOT_IN_HOUSEHOLD);

  const rows = await tx
    .select({
      id: transaction.id,
      householdId: transaction.householdId,
      payee: transaction.payee,
      deletedAt: transaction.deletedAt,
    })
    .from(transaction)
    .where(eq(transaction.householdId, householdId))
    .for("update");

  const splitRows = await tx
    .select({
      transactionId: transactionSplit.transactionId,
      categoryId: transactionSplit.categoryId,
    })
    .from(transactionSplit)
    .where(eq(transactionSplit.householdId, householdId));

  const splitsByTransaction = new Map<string, { categoryId: string }[]>();
  for (const split of splitRows) {
    const list = splitsByTransaction.get(split.transactionId) ?? [];
    list.push({ categoryId: split.categoryId });
    splitsByTransaction.set(split.transactionId, list);
  }

  const candidates: PayeeRuleApplyCandidate[] = rows.map((row) => ({
    id: row.id,
    householdId: row.householdId,
    payee: row.payee,
    deletedAt: row.deletedAt,
    splits: splitsByTransaction.get(row.id) ?? [],
  }));

  return {
    ruleId: rule.id,
    pattern: rule.pattern,
    categoryId: rule.categoryId,
    categoryName: categoryLabel(rule.categoryName, rule.groupName),
    plan: planPayeeRuleApply(
      { householdId, pattern: rule.pattern, categoryId: rule.categoryId },
      candidates,
    ),
  };
}

/**
 * Plans and writes in the caller's transaction. `withActor` is that
 * transaction: the count and the category updates commit or roll back together.
 */
export async function applyPayeeRuleInTransaction(
  tx: AppTx,
  householdId: string,
  ruleId: string,
): Promise<LoadedPayeeRuleApply> {
  const loaded = await loadPayeeRuleApply(tx, householdId, ruleId);
  if (loaded.plan.changeIds.length === 0) return loaded;
  await tx
    .update(transactionSplit)
    .set({ categoryId: loaded.categoryId })
    .where(
      and(
        eq(transactionSplit.householdId, householdId),
        inArray(transactionSplit.transactionId, loaded.plan.changeIds),
      ),
    );
  return loaded;
}

/** Deletes one rule in this household. Another household's id removes nothing. */
export async function removePayeeRuleInTransaction(
  tx: AppTx,
  householdId: string,
  ruleId: string,
): Promise<{ id: string; pattern: string }> {
  const removed = await tx
    .delete(payeeCategoryRule)
    .where(and(eq(payeeCategoryRule.id, ruleId), eq(payeeCategoryRule.householdId, householdId)))
    .returning({ id: payeeCategoryRule.id, pattern: payeeCategoryRule.pattern });
  const rule = removed[0];
  if (!rule) throw new Error(PAYEE_RULE_NOT_IN_HOUSEHOLD);
  return rule;
}
