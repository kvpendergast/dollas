import { err, ok, type Result } from "neverthrow";
import { SplitGroupError } from "../errors";
import { formatCents } from "../money/cents";
import { NOTE_MAX_LENGTH, PAYEE_MAX_LENGTH } from "./entry";
import { linkedDepositUndoWarning } from "./transfer-pair";

/**
 * Split transactions (PEN-347/348): one bank row divided into child
 * transactions. Two kinds, decided by the parent:
 *
 * - "income": a paycheck. The parent is positive and every category line on
 *   it is an income category. The parent counts as gross income; its lines
 *   are negative (taxes and deductions are expenses, 401k and net pay are
 *   transfers) and add up to minus the gross. A transfer line may name a
 *   destination account, which then gets a matching positive deposit.
 * - "allocation": anything else (a Costco run, a Venmo payment). The parent
 *   leaves every total and its lines count instead. Lines share the parent's
 *   sign and add up to it. An outflow line can be marked reimbursed: it stays
 *   on the account but leaves spending.
 *
 * Callers give each line's size as a positive amount (how much of the parent
 * it takes) or as a percent of whatever the fixed lines leave over.
 */

export const MAX_SPLIT_LINES = 20;

export type SplitKind = "income" | "allocation";

export type SplitCategoryKind = "income" | "expense" | "transfer";

export const SPLIT_GROUP_COPY = {
  action: "Split into transactions",
  edit: "Edit split",
  unsplit: "Unsplit",
  addLine: "Add a line",
  removeLine: "Remove",
  reimbursed: "Paid back",
  reimbursedHint: "Someone pays you back for this part. It stays on the account but leaves spending.",
  toAccount: "Deposit to",
  incomeHint: "A paycheck counts as gross income. Its lines are taxes and deductions (expenses) or transfers like 401(k) and net pay.",
  allocationHint: "The lines replace this transaction in every total.",
  partOf: "Part of a split",
  locked: "This is part of a split. Change it with Edit split on the split, or unsplit it first.",
  parentLocked: "This transaction is split. Use Edit split, or unsplit it first.",
} as const;

export const SPLIT_LIMIT = `A split can have at most ${MAX_SPLIT_LINES} lines.`;

export type SplitLineDraft = {
  payee?: string | null;
  categoryId: string;
  categoryKind: SplitCategoryKind;
  /** Positive: how much of the parent this line takes. */
  amountCents?: number | null;
  /** Percent of what the fixed-amount lines leave over. */
  remainderPercent?: number | null;
  toAccountId?: string | null;
  reimbursed?: boolean;
  note?: string | null;
};

export type SplitLine = {
  position: number;
  payee: string;
  categoryId: string;
  /** Signed, as stored: negative on an income split and on an outflow. */
  amountCents: number;
  toAccountId: string | null;
  reimbursed: boolean;
  note: string | null;
};

export type SplitPlan = { kind: SplitKind; lines: SplitLine[] };

export type SplitParent = {
  amountCents: number;
  accountId: string;
  payee: string;
  /** The kinds of the parent's own category lines. */
  categoryKinds: readonly SplitCategoryKind[];
};

/** "income" when the parent is a positive row categorized only as income; otherwise "allocation". */
export function splitKindFor(parent: Pick<SplitParent, "amountCents" | "categoryKinds">): SplitKind {
  return parent.amountCents > 0 && parent.categoryKinds.length > 0 && parent.categoryKinds.every((kind) => kind === "income")
    ? "income"
    : "allocation";
}

/** Parent size minus the lines: positive is still unassigned, negative is over. */
export function splitDifferenceCents(parentAmountCents: number, lineMagnitudes: readonly number[]): number {
  return Math.abs(parentAmountCents) - lineMagnitudes.reduce((sum, cents) => sum + cents, 0);
}

/** Member copy for a difference: "$100.00 left to assign." */
export function describeSplitDifference(differenceCents: number): string {
  if (differenceCents === 0) return "The lines add up.";
  return differenceCents > 0
    ? `${formatCents(differenceCents)} left to assign.`
    : `The lines are ${formatCents(-differenceCents)} over.`;
}

/** Divide cents by percents (summing to 100). Each share rounds down; the leftover cents go to the last share. */
export function divideByPercent(totalCents: number, percents: readonly number[]): number[] {
  const shares = percents.map((percent) => Math.floor((totalCents * percent) / 100));
  const given = shares.reduce((sum, cents) => sum + cents, 0);
  if (shares.length > 0) shares[shares.length - 1] += totalCents - given;
  return shares;
}

function fail(message: string, differenceCents: number | null = null) {
  return err(new SplitGroupError(message, differenceCents));
}

/**
 * Check and size a split. Lines come back signed and in order, with payees
 * defaulted to the parent's.
 */
export function planSplit(parent: SplitParent, drafts: readonly SplitLineDraft[]): Result<SplitPlan, SplitGroupError> {
  if (!Number.isSafeInteger(parent.amountCents) || parent.amountCents === 0) {
    return fail("A split needs a transaction with an amount.");
  }
  if (drafts.length === 0) return fail("Add at least one line.");
  if (drafts.length > MAX_SPLIT_LINES) return fail(SPLIT_LIMIT);
  const kind = splitKindFor(parent);
  const total = Math.abs(parent.amountCents);
  const sign = kind === "income" ? -1 : Math.sign(parent.amountCents);

  let fixed = 0;
  let percentSum = 0;
  const percentIndexes: number[] = [];
  for (const [index, draft] of drafts.entries()) {
    const label = `Line ${index + 1}`;
    if (!draft.categoryId || draft.categoryId.trim() === "") return fail(`${label} needs a category.`);
    const hasAmount = draft.amountCents != null;
    const hasPercent = draft.remainderPercent != null;
    if (hasAmount === hasPercent) return fail(`${label} needs an amount or a percent of the rest, not both.`);
    if (hasAmount) {
      const cents = draft.amountCents as number;
      if (!Number.isSafeInteger(cents) || cents <= 0) return fail(`${label} needs an amount above zero, in whole cents.`);
      fixed += cents;
    } else {
      const percent = draft.remainderPercent as number;
      if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return fail(`${label} needs a percent between 0 and 100.`);
      percentSum += percent;
      percentIndexes.push(index);
    }
    if (kind === "income") {
      if (draft.categoryKind === "income") {
        return fail(`${label}: a paycheck's lines are expenses (taxes, deductions) or transfers (401(k), net pay). The income category stays on the paycheck.`);
      }
      if (draft.reimbursed) return fail(`${label}: only lines of a charge can be paid back.`);
    } else {
      if (draft.toAccountId) return fail(`${label}: only a paycheck's transfer lines can deposit to another account.`);
      if (draft.reimbursed && parent.amountCents > 0) return fail(`${label}: only lines of a charge can be paid back.`);
    }
    if (draft.toAccountId) {
      if (draft.categoryKind !== "transfer") return fail(`${label}: a deposit line needs a transfer category.`);
      if (draft.toAccountId === parent.accountId) return fail(`${label}: deposit to a different account than the paycheck's.`);
    }
    if ((draft.payee ?? "").trim().length > PAYEE_MAX_LENGTH) return fail(`${label}: payee is too long.`);
    if ((draft.note ?? "").trim().length > NOTE_MAX_LENGTH) return fail(`${label}: note is too long.`);
  }

  const magnitudes = drafts.map((draft) => draft.amountCents ?? 0);
  if (percentIndexes.length > 0) {
    if (Math.abs(percentSum - 100) > 1e-6) return fail("The percents of the rest must add up to 100.");
    const rest = total - fixed;
    if (rest <= 0) return fail("The fixed lines leave nothing for the percent lines.", rest);
    const shares = divideByPercent(rest, percentIndexes.map((index) => drafts[index]?.remainderPercent ?? 0));
    for (const [at, index] of percentIndexes.entries()) {
      const share = shares[at] ?? 0;
      if (share <= 0) return fail(`Line ${index + 1} rounds to zero.`);
      magnitudes[index] = share;
    }
  }
  const difference = splitDifferenceCents(parent.amountCents, magnitudes);
  if (difference !== 0) {
    return fail(`The lines must add up to ${formatCents(total)}. ${describeSplitDifference(difference)}`, difference);
  }
  return ok({
    kind,
    lines: drafts.map((draft, index) => ({
      position: index,
      payee: (draft.payee ?? "").trim() || parent.payee,
      categoryId: draft.categoryId,
      amountCents: sign * (magnitudes[index] ?? 0),
      toAccountId: draft.toAccountId ?? null,
      reimbursed: draft.reimbursed ?? false,
      note: (draft.note ?? "").trim() || null,
    })),
  });
}

/** Totals: an allocation parent leaves balances and books; a reimbursed line leaves books only. */
export function splitCounts(row: { splitKind: SplitKind | null; reimbursed: boolean }): { balances: boolean; books: boolean } {
  const balances = row.splitKind !== "allocation";
  return { balances, books: balances && !row.reimbursed };
}

/** The warning next to Undo when splits are built on an import, or "" when none are. */
export function splitUndoWarning(splitCount: number, replacedCount: number, linkedCount = 0): string {
  const parts: string[] = [];
  if (splitCount > 0) {
    parts.push(
      `${splitCount === 1 ? "1 split is" : `${splitCount} splits are`} built on this import. Undoing it removes ${splitCount === 1 ? "that split and its lines" : "those splits and their lines"}.`,
    );
  }
  if (replacedCount > 0) {
    parts.push(`${replacedCount === 1 ? "1 transaction" : `${replacedCount} transactions`} from it ${replacedCount === 1 ? "is" : "are"} replaced by a split; undo removes ${replacedCount === 1 ? "it" : "them"} for good and the split stays.`);
  }
  const linked = linkedDepositUndoWarning(linkedCount);
  if (linked) parts.push(linked);
  return parts.join(" ");
}
