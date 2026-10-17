import { DomainError, hidesSetupDetail, matchingPayeeRule, memberFacingMessage, payeeRuleKey } from "@dollas/domain";

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

export type PayeeRuleSample = { payee: string; count: number };

export type PayeeRuleConflict = {
  ruleId: string;
  pattern: string;
  categoryId: string;
  sameCategory: boolean;
  /** On a new import or sync this other rule wins for the shared payees (longer text wins, as in matchingPayeeRule). */
  winsOnImport: boolean;
  sharedPayees: string[];
};

export type PayeeRulePreviewDetails = {
  samplePayees: PayeeRuleSample[];
  conflicts: PayeeRuleConflict[];
};

const SAMPLE_LIMIT = 10;

/**
 * What a rule matches among existing transactions, for previews (PEN-282): the
 * distinct payees it matches (most frequent first, up to ten) and the other
 * rules that also match some of those payees. Applying a rule ignores other
 * rules, but a new import or sync lets the longer text win, so an overlap with a
 * different category is worth a look before applying.
 */
export function payeeRulePreviewDetails(
  rule: { id: string; householdId: string; pattern: string; categoryId: string },
  others: readonly { id: string; pattern: string; categoryId: string }[],
  transactions: readonly { householdId: string; payee: string; deletedAt: Date | string | null }[],
): PayeeRulePreviewDetails {
  const needle = payeeRuleKey(rule.pattern);
  const counts = new Map<string, { payee: string; count: number }>();
  for (const row of transactions) {
    if (row.householdId !== rule.householdId || row.deletedAt != null) continue;
    if (needle.length === 0 || !row.payee.toLowerCase().includes(needle)) continue;
    const key = row.payee.trim().toLowerCase();
    const seen = counts.get(key);
    if (seen) seen.count += 1;
    else counts.set(key, { payee: row.payee.trim(), count: 1 });
  }
  const matched = [...counts.values()].sort((a, b) => b.count - a.count || a.payee.localeCompare(b.payee));
  const conflicts: PayeeRuleConflict[] = [];
  for (const other of others) {
    if (other.id === rule.id) continue;
    const otherKey = payeeRuleKey(other.pattern);
    if (otherKey.length === 0) continue;
    const shared = matched.filter((item) => item.payee.toLowerCase().includes(otherKey));
    if (shared.length === 0) continue;
    conflicts.push({
      ruleId: other.id,
      pattern: other.pattern,
      categoryId: other.categoryId,
      sameCategory: other.categoryId === rule.categoryId,
      winsOnImport: otherKey.length > needle.length || (otherKey.length === needle.length && otherKey.localeCompare(needle) < 0),
      sharedPayees: shared.slice(0, 5).map((item) => item.payee),
    });
  }
  conflicts.sort((a, b) => Number(a.sameCategory) - Number(b.sameCategory) || a.pattern.localeCompare(b.pattern));
  return { samplePayees: matched.slice(0, SAMPLE_LIMIT), conflicts };
}
