import { DomainError, hidesSetupDetail, matchingPayeeRule, memberFacingMessage } from "@dollas/domain";

export const PAYEE_RULE_NOT_IN_HOUSEHOLD = "That payee rule is not in this household.";
export const PAYEE_RULE_CATEGORY = "Choose a category in this household.";
export const PAYEE_RULE_DUPLICATE = "That payee match is already a rule.";

const KNOWN = new Set([PAYEE_RULE_CATEGORY, PAYEE_RULE_DUPLICATE, PAYEE_RULE_NOT_IN_HOUSEHOLD]);

/**
 * Which existing transactions a saved payee rule would recategorize.
 *
 * Matching is the same containment test as a new import or bank sync for this
 * rule alone: the payee contains the rule text, ignoring case. Other rules are
 * not consulted, because the member asked to apply this rule.
 *
 * Ignored, and not part of either count:
 * - a transaction from another household
 * - a soft-deleted transaction (`deletedAt` is set)
 * - a transaction that already has this category on its only category line
 *
 * Split transactions (more than one category line) are skipped. Rewriting a
 * split the member entered would drop that breakdown, so those rows stay as
 * they are. The skipped count is how many of them matched and were left alone.
 *
 * A transaction with no category line is also skipped, in its own count. The
 * books keep category lines that add up to the transaction, and this step only
 * retargets one existing line. It does not invent one.
 */
export type PayeeRuleApplyCandidate = {
  id: string;
  householdId: string;
  payee: string;
  deletedAt: Date | string | null;
  splits: readonly { categoryId: string }[];
};

export type PayeeRuleApplyPlan = {
  changeIds: string[];
  skippedSplitIds: string[];
  skippedWithoutCategoryIds: string[];
};

export function planPayeeRuleApply(
  rule: { householdId: string; pattern: string; categoryId: string },
  transactions: readonly PayeeRuleApplyCandidate[],
): PayeeRuleApplyPlan {
  const changeIds: string[] = [];
  const skippedSplitIds: string[] = [];
  const skippedWithoutCategoryIds: string[] = [];
  const needle = { pattern: rule.pattern, categoryId: rule.categoryId };

  for (const transaction of transactions) {
    if (transaction.householdId !== rule.householdId) continue;
    if (transaction.deletedAt != null) continue;
    if (matchingPayeeRule(transaction.payee, [needle]) == null) continue;
    if (transaction.splits.length > 1) {
      skippedSplitIds.push(transaction.id);
      continue;
    }
    if (transaction.splits.length === 0) {
      skippedWithoutCategoryIds.push(transaction.id);
      continue;
    }
    const only = transaction.splits[0];
    if (!only || only.categoryId === rule.categoryId) continue;
    changeIds.push(transaction.id);
  }

  return { changeIds, skippedSplitIds, skippedWithoutCategoryIds };
}

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

/**
 * Sentence a member can read. Setup and provider failures keep their detail
 * in the server log and are mapped through `memberFacingMessage`.
 */
export function payeeRuleMemberMessage(error: unknown, fallback: string): string {
  if (hidesSetupDetail(error)) return memberFacingMessage(error, fallback);
  if (error instanceof DomainError) return memberFacingMessage(error, fallback);
  if (error instanceof Error && KNOWN.has(error.message)) return error.message;
  if (errorText(error).includes("payee rule category must belong to the same household")) {
    return PAYEE_RULE_CATEGORY;
  }
  if (isUniqueViolation(error)) return PAYEE_RULE_DUPLICATE;
  return fallback;
}
