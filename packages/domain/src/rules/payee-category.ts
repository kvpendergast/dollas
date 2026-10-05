import { err, ok, type Result } from "neverthrow";
import { PayeeCategoryRuleError } from "../errors";

const PATTERN_MIN = 2;
const PATTERN_MAX = 200;

/** A standing instruction: when a payee contains `pattern`, use `categoryId`. */
export type PayeeCategoryRule = {
  pattern: string;
  categoryId: string;
};

/**
 * The household text for a payee rule. Matching ignores case and surrounding
 * spaces, so "Market" and " market " are the same rule.
 */
export function payeeRuleKey(pattern: string): string {
  return pattern.trim().toLowerCase();
}

/** A member names the payee text and the category new imports should use. */
export function definePayeeCategoryRule(input: {
  pattern: string;
  categoryId: string;
}): Result<PayeeCategoryRule, PayeeCategoryRuleError> {
  const pattern = input.pattern.trim();
  if (pattern.length < PATTERN_MIN) {
    return err(new PayeeCategoryRuleError("Enter the payee text to match."));
  }
  if (pattern.length > PATTERN_MAX || /[\r\n]/.test(pattern)) {
    return err(new PayeeCategoryRuleError("Use a shorter payee match."));
  }
  const categoryId = input.categoryId.trim();
  if (categoryId.length === 0) {
    return err(new PayeeCategoryRuleError("Choose a category."));
  }
  return ok({ pattern, categoryId });
}

/**
 * The rule whose text is contained in the payee. A longer text wins, so
 * "Market, Downtown" beats "Market". Matching ignores case.
 * Returns null when nothing matches. The rule list is not changed.
 */
export function matchingPayeeRule(
  payee: string,
  rules: readonly PayeeCategoryRule[],
): PayeeCategoryRule | null {
  const haystack = payee.toLowerCase();
  const matches = rules.filter((rule) => {
    const needle = payeeRuleKey(rule.pattern);
    return needle.length > 0 && haystack.includes(needle);
  });
  matches.sort((a, b) => {
    const length = payeeRuleKey(b.pattern).length - payeeRuleKey(a.pattern).length;
    if (length !== 0) return length;
    return payeeRuleKey(a.pattern).localeCompare(payeeRuleKey(b.pattern));
  });
  return matches[0] ?? null;
}
