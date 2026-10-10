import { err, ok, type Result } from "neverthrow";
import { TransactionError } from "../errors";
import { isIsoDate } from "../connections/sync";
import { validateSplits, type BalancedSplit } from "./splits";

/**
 * A transaction as Add, Edit, and the MCP tools submit it. Money is signed
 * integer cents (negative is money out); splits share that sign and add back
 * to the total. One category is one split for the whole amount.
 */
export type TransactionEntryInput = {
  payee: string;
  occurredOn: string;
  accountId: string;
  amountCents: number;
  splits: ReadonlyArray<{ categoryId: string; amountCents: number }>;
};

export type TransactionEntry = {
  payee: string;
  occurredOn: string;
  accountId: string;
  amountCents: number;
  splits: BalancedSplit[];
};

/** Fields an edit may change. Anything left out keeps its current value. */
export type TransactionEntryPatch = Partial<TransactionEntryInput>;

export const PAYEE_MAX_LENGTH = 200;

export function defineTransactionEntry(input: TransactionEntryInput): Result<TransactionEntry, TransactionError> {
  const payee = input.payee.trim();
  if (payee.length < 1) return err(new TransactionError("Enter a payee."));
  if (payee.length > PAYEE_MAX_LENGTH) return err(new TransactionError(`Keep the payee under ${PAYEE_MAX_LENGTH} characters.`));
  if (!isIsoDate(input.occurredOn)) return err(new TransactionError("Choose a date."));
  if (input.accountId.trim().length === 0) return err(new TransactionError("Choose an account."));
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents === 0) {
    return err(new TransactionError("Enter an amount greater than zero."));
  }
  const balanced = validateSplits(input.amountCents, input.splits);
  if (balanced.isErr()) return err(new TransactionError(balanced.error.message));
  return ok({ payee, occurredOn: input.occurredOn, accountId: input.accountId, amountCents: input.amountCents, splits: balanced.value });
}

/**
 * Applies an edit to the stored transaction. A new amount without new splits
 * moves a single-category transaction with it; a split transaction needs the
 * splits restated so they still add up.
 */
export function amendTransactionEntry(
  current: TransactionEntryInput,
  patch: TransactionEntryPatch,
): Result<TransactionEntry, TransactionError> {
  const amountCents = patch.amountCents ?? current.amountCents;
  let splits = patch.splits ?? current.splits;
  if (patch.splits === undefined && amountCents !== current.amountCents) {
    if (current.splits.length > 1) {
      return err(new TransactionError("This transaction is split. Give the splits again so they add up to the new amount."));
    }
    splits = current.splits.map((split) => ({ categoryId: split.categoryId, amountCents }));
  }
  return defineTransactionEntry({
    payee: patch.payee ?? current.payee,
    occurredOn: patch.occurredOn ?? current.occurredOn,
    accountId: patch.accountId ?? current.accountId,
    amountCents,
    splits,
  });
}
