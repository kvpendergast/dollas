import { err, ok, type Result } from "neverthrow";
import { BANK_MATCH_WINDOW_DAYS } from "../connections/match";
import { SplitGroupError } from "../errors";
import { formatCents } from "../money/cents";
import { daysBetween } from "../recurring/schedule";

/**
 * Transfer pairs (PEN-349). A paycheck's net-pay line (a negative transfer
 * line on an income split) can be linked to the real deposit that bank sync or
 * a CSV already put in the destination account. The deposit then takes the
 * line's transfer category: it stops counting as income and the destination
 * balance counts the money once. Links are only ever made by a member or an
 * agent acting on a suggestion; nothing links on its own.
 */

export const TRANSFER_PAIR_COPY = {
  link: "Link deposit",
  unlink: "Unlink deposit",
  linkedTo: "Linked deposit",
  deposit: "Net pay from",
  existing: "Existing deposit",
  newDeposit: "New deposit to",
  noDeposit: "No deposit",
  depositLocked: "This deposit is linked to a paycheck's net pay. Unlink it to change the amount, account or category.",
  hint: "Link the deposit your bank already has, so the net pay counts once.",
} as const;

/** How far apart (days) a paycheck and its deposit can be and still be suggested. */
export const TRANSFER_PAIR_WINDOW_DAYS = BANK_MATCH_WINDOW_DAYS;

export const MAX_TRANSFER_SUGGESTIONS = 5;

export type TransferLineFacts = {
  id: string;
  householdId: string;
  accountId: string;
  occurredOn: string;
  /** Signed, as stored: negative on a paycheck line. */
  amountCents: number;
  /** Is it a line (not a deposit) of a live income split? */
  incomeLine: boolean;
  /** Are all its category lines transfer categories? */
  transferOnly: boolean;
  linkedDepositId: string | null;
};

export type TransferDepositFacts = {
  id: string;
  householdId: string;
  accountId: string;
  occurredOn: string;
  amountCents: number;
  deleted: boolean;
  /** Part of a split (parent, line or split deposit) or replaced by one. */
  splitRow: boolean;
  /** The line it is already linked to, if any. */
  linkedLineId: string | null;
};

/** "linked" for a new link, "exists" when the same pair is already there. */
export function decideTransferLink(line: TransferLineFacts | null, deposit: TransferDepositFacts | null, householdId: string): Result<"linked" | "exists", SplitGroupError> {
  if (!line || line.householdId !== householdId) return err(new SplitGroupError("That net-pay line is not in this household."));
  if (!deposit || deposit.householdId !== householdId) return err(new SplitGroupError("That deposit is not in this household."));
  if (line.linkedDepositId === deposit.id && deposit.linkedLineId === line.id) return ok("exists");
  if (!line.incomeLine) return err(new SplitGroupError("Link a deposit to a line of a paycheck split."));
  if (!line.transferOnly) return err(new SplitGroupError("Only a transfer line (like net pay) can be linked to a deposit."));
  if (line.linkedDepositId) return err(new SplitGroupError("That line is already linked to a deposit. Unlink it first."));
  if (deposit.deleted) return err(new SplitGroupError("That deposit is deleted. Restore it first."));
  if (deposit.splitRow) return err(new SplitGroupError("That deposit is part of a split. Choose the bank's own deposit."));
  if (deposit.linkedLineId) return err(new SplitGroupError("That deposit is already linked to another paycheck."));
  if (deposit.accountId === line.accountId) return err(new SplitGroupError("Choose a deposit in another account."));
  if (deposit.amountCents !== -line.amountCents) {
    return err(
      new SplitGroupError(
        `The deposit is ${formatCents(deposit.amountCents)} and the line is ${formatCents(-line.amountCents)}. Link a deposit for the same amount.`,
        -line.amountCents - deposit.amountCents,
      ),
    );
  }
  return ok("linked");
}

export type TransferCandidate = { id: string; accountId: string; occurredOn: string; amountCents: number };

/**
 * Deposits worth suggesting for a line: the same amount, another account,
 * within the bank-match window. Nearest date first; the account a v1 deposit
 * already names wins ties. Only suggestions: the caller confirms each link.
 */
export function rankTransferCandidates<T extends TransferCandidate>(
  line: { accountId: string; occurredOn: string; amountCents: number; preferredAccountId?: string | null },
  candidates: readonly T[],
  limit = MAX_TRANSFER_SUGGESTIONS,
): T[] {
  return candidates
    .filter(
      (row) =>
        row.amountCents === -line.amountCents &&
        row.amountCents > 0 &&
        row.accountId !== line.accountId &&
        daysBetween(row.occurredOn, line.occurredOn) <= TRANSFER_PAIR_WINDOW_DAYS,
    )
    .sort((a, b) => {
      const byDays = daysBetween(a.occurredOn, line.occurredOn) - daysBetween(b.occurredOn, line.occurredOn);
      if (byDays !== 0) return byDays;
      const preferred = Number(b.accountId === line.preferredAccountId) - Number(a.accountId === line.preferredAccountId);
      if (preferred !== 0) return preferred;
      return a.occurredOn === b.occurredOn ? a.id.localeCompare(b.id) : a.occurredOn.localeCompare(b.occurredOn);
    })
    .slice(0, Math.max(0, limit));
}

/** The CSV-undo warning for deposits from an import that are linked to paychecks, or "". */
export function linkedDepositUndoWarning(linkedCount: number): string {
  if (linkedCount <= 0) return "";
  return `${linkedCount === 1 ? "1 deposit" : `${linkedCount} deposits`} from this import ${linkedCount === 1 ? "is" : "are"} linked to a paycheck's net pay. Undoing it removes ${linkedCount === 1 ? "that deposit" : "those deposits"}; the paycheck lines stay, with no deposit.`;
}
