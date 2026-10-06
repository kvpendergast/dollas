import { isCategoryKind, type CategoryKind } from "../categories/define";

/** Money out of the account, or money into it. A transfer category does not pick one. */
export type TransactionDirection = "expense" | "income";

export type DirectionCategoryNotice = {
  tone: "warning" | "note";
  message: string;
};

const TRANSFER_NOTE =
  "Transfers move money between accounts and do not count as income or spending.";

/**
 * The direction a new choice of category suggests.
 * Income and expense categories match their kind. A transfer leaves the
 * direction alone: the money still entered or left this account, and the
 * category is neither income nor spending.
 */
export function directionDefaultForKind(kind: string): TransactionDirection | null {
  if (!isCategoryKind(kind)) return null;
  if (kind === "income") return "income";
  if (kind === "expense") return "expense";
  return null;
}

/**
 * Warn when an income or expense category fights the direction.
 * A transfer never disagrees; it explains that it will not count as either.
 */
export function directionCategoryNotice(
  direction: TransactionDirection,
  kind: string,
): DirectionCategoryNotice | null {
  if (!isCategoryKind(kind)) return null;
  return noticeFor(direction, kind);
}

function noticeFor(direction: TransactionDirection, kind: CategoryKind): DirectionCategoryNotice | null {
  if (kind === "transfer") {
    return { tone: "note", message: TRANSFER_NOTE };
  }
  if (kind === direction) return null;
  if (kind === "income") {
    return { tone: "warning", message: "This category is income, but the direction is an expense." };
  }
  return { tone: "warning", message: "This category is an expense, but the direction is income." };
}
