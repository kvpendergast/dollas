/**
 * Member copy for payee rules.
 * Rules run when a new CSV import or bank sync is written. They do not rewrite
 * the books on their own. Applying a rule to existing rows is a separate step,
 * and that step says how many transactions would change before it writes.
 */

export const PAYEE_RULES_APPLY_TO =
  "Rules apply to new CSV imports and bank syncs. They do not change transactions already in the books.";

export type PayeeRuleApplyCounts = {
  pattern: string;
  categoryName: string;
  changeCount: number;
  skippedSplitCount: number;
  skippedWithoutCategoryCount: number;
};

function countPhrase(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Confirmation before a rule is deleted. Names the saved payee text. */
export function describePayeeRuleRemoval(rule: { pattern: string; categoryName: string }): {
  title: string;
  body: string;
} {
  return {
    title: `Remove the "${rule.pattern}" rule?`,
    body: `New CSV imports and bank syncs will no longer use ${rule.categoryName} when a payee contains "${rule.pattern}". Transactions already in the books stay as they are.`,
  };
}

/**
 * Count shown before a rule is applied to transactions already in the books.
 * Split transactions are called out separately so the member sees how many
 * were left alone.
 */
export function describePayeeRuleApply(input: PayeeRuleApplyCounts): { title: string; body: string } {
  const change =
    input.changeCount === 0
      ? `No transactions matching "${input.pattern}" would move to ${input.categoryName}.`
      : `${countPhrase(input.changeCount, "transaction", "transactions")} matching "${input.pattern}" will move to ${input.categoryName}.`;
  return {
    title: `Apply the "${input.pattern}" rule to existing transactions?`,
    body: [change, ...skipSentences(input, "will be skipped")].join(" "),
  };
}

/** What the apply step did, using the counts from the same database transaction. */
export function describePayeeRuleApplied(input: PayeeRuleApplyCounts): string {
  const moved =
    input.changeCount === 1
      ? `Moved 1 transaction to ${input.categoryName}.`
      : `Moved ${input.changeCount} transactions to ${input.categoryName}.`;
  const skipped = skipSentences(input, "skipped");
  return [moved, ...skipped].join(" ");
}

function skipSentences(input: PayeeRuleApplyCounts, verb: string): string[] {
  const sentences: string[] = [];
  if (input.skippedSplitCount > 0) {
    sentences.push(
      `${countPhrase(input.skippedSplitCount, "split transaction", "split transactions")} ${verb}.`,
    );
  }
  if (input.skippedWithoutCategoryCount > 0) {
    sentences.push(
      `${countPhrase(input.skippedWithoutCategoryCount, "transaction with no category line", "transactions with no category line")} ${verb}.`,
    );
  }
  return sentences;
}
