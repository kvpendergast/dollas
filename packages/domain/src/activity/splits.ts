import { err, ok, type Result } from "neverthrow";
import { SplitImbalanceError } from "../errors";
import { assertCents, type Cents } from "../money/cents";

/** Add and Edit both stop here. One category can appear only once, so the practical cap is lower when the household has fewer categories. */
export const MAX_TRANSACTION_SPLITS = 12;

export const SPLIT_LIMIT_MESSAGE = `A transaction can use at most ${MAX_TRANSACTION_SPLITS} categories.`;

/** Shared labels for the Activity split control. Add and Edit render these and no others. */
export const SPLIT_CONTROL_COPY = {
  split: "Split across categories",
  single: "Use one category",
  add: "Add a category",
  remove: "Remove",
  hint: "Each part is in dollars. The parts must add up to the amount.",
  limit: SPLIT_LIMIT_MESSAGE,
} as const;

export type SplitDraft = {
  categoryId: string;
  amountCents: Cents;
};

export type BalancedSplit = {
  categoryId: string;
  amountCents: Cents;
};

/**
 * A transaction may be divided across categories. Every split shares the
 * transaction's sign, and the parts add back to the whole.
 */
export function validateSplits(
  totalCents: number,
  splits: readonly SplitDraft[],
): Result<BalancedSplit[], SplitImbalanceError> {
  const total = assertCents(totalCents);
  if (total.isErr()) {
    return err(new SplitImbalanceError(total.error.message));
  }
  if (splits.length === 0) {
    return err(new SplitImbalanceError("Choose at least one category."));
  }
  if (splits.length > MAX_TRANSACTION_SPLITS) {
    return err(new SplitImbalanceError(SPLIT_LIMIT_MESSAGE));
  }
  const seen = new Set<string>();
  let sum = 0;
  const balanced: BalancedSplit[] = [];
  for (const split of splits) {
    if (split.categoryId.trim().length === 0) {
      return err(new SplitImbalanceError("Each split needs a category."));
    }
    if (seen.has(split.categoryId)) {
      return err(new SplitImbalanceError("A category can only appear once on a transaction."));
    }
    seen.add(split.categoryId);
    const amount = assertCents(split.amountCents);
    if (amount.isErr()) {
      return err(new SplitImbalanceError(amount.error.message));
    }
    if (amount.value === 0) {
      return err(new SplitImbalanceError("Split amounts cannot be zero."));
    }
    if (Math.sign(amount.value) !== Math.sign(total.value)) {
      return err(new SplitImbalanceError("Splits must match the transaction direction."));
    }
    sum += amount.value;
    balanced.push({ categoryId: split.categoryId, amountCents: amount.value });
  }
  if (sum !== total.value) {
    return err(
      new SplitImbalanceError("Category splits must add up to the transaction amount."),
    );
  }
  return ok(balanced);
}

/** True when another category row still fits under the shared cap and the household has an unused category. */
export function canAddSplit(currentCount: number, availableCategoryCount: number): boolean {
  if (!Number.isInteger(currentCount) || !Number.isInteger(availableCategoryCount)) return false;
  if (currentCount < 1 || availableCategoryCount < 1) return false;
  return currentCount < MAX_TRANSACTION_SPLITS && currentCount < availableCategoryCount;
}
