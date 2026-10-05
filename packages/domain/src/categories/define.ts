import { err, ok, type Result } from "neverthrow";
import { InvalidCategoryError, InvalidMoneyError } from "../errors";
import { assertCents, expenseMagnitude, incomeMagnitude, type Cents } from "../money/cents";

/** A category is income, an expense, or a transfer between accounts. */
export const categoryKinds = ["income", "expense", "transfer"] as const;

export type CategoryKind = (typeof categoryKinds)[number];

export type DefinedCategoryGroup = {
  name: string;
};

export type DefinedCategory = {
  name: string;
  kind: CategoryKind;
  groupId: string;
};

export type CategoryBooksEffect = {
  incomeCents: Cents;
  spentCents: Cents;
};

const NAME_LIMIT = 80;

export function isCategoryKind(value: string): value is CategoryKind {
  return (categoryKinds as readonly string[]).includes(value);
}

export function categoryKindLabel(kind: CategoryKind): string {
  if (kind === "income") return "Income";
  if (kind === "expense") return "Expense";
  return "Transfer";
}

function definedName(raw: string, emptyMessage: string): Result<string, InvalidCategoryError> {
  const name = raw.trim();
  if (name.length < 2) return err(new InvalidCategoryError(emptyMessage));
  if (name.length > NAME_LIMIT) return err(new InvalidCategoryError("Use a shorter name."));
  return ok(name);
}

/** A household names a group, then files categories under it. */
export function defineCategoryGroup(name: string): Result<DefinedCategoryGroup, InvalidCategoryError> {
  const defined = definedName(name, "Name the group.");
  if (defined.isErr()) return err(defined.error);
  return ok({ name: defined.value });
}

/**
 * New categories belong to a group and are one of the three kinds.
 * Existing rows may stay ungrouped; this is the rule for ones a member adds.
 */
export function defineCategory(input: {
  name: string;
  kind: string;
  groupId: string;
}): Result<DefinedCategory, InvalidCategoryError> {
  const name = definedName(input.name, "Name the category.");
  if (name.isErr()) return err(name.error);
  if (!isCategoryKind(input.kind)) {
    return err(new InvalidCategoryError("Choose income, expense, or transfer."));
  }
  const groupId = input.groupId.trim();
  if (groupId.length === 0) return err(new InvalidCategoryError("Choose a group."));
  return ok({ name: name.value, kind: input.kind, groupId });
}

/**
 * How a categorized split counts in the books.
 * Income and expense follow the sign of the money. A transfer moves money
 * and is neither income nor spending.
 */
export function categoryBooksEffect(
  kind: string,
  amountCents: number,
): Result<CategoryBooksEffect, InvalidCategoryError | InvalidMoneyError> {
  if (!isCategoryKind(kind)) {
    return err(new InvalidCategoryError("Choose income, expense, or transfer."));
  }
  const cents = assertCents(amountCents);
  if (cents.isErr()) return err(cents.error);
  if (kind === "income") {
    return ok({ incomeCents: incomeMagnitude(cents.value), spentCents: 0 });
  }
  if (kind === "expense") {
    return ok({ incomeCents: 0, spentCents: expenseMagnitude(cents.value) });
  }
  return ok({ incomeCents: 0, spentCents: 0 });
}
