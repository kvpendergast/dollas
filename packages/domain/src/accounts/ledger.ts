import { err, ok, type Result } from "neverthrow";
import { AccountError, InvalidMoneyError } from "../errors";
import { assertCents, parseDollarInput, type Cents } from "../money/cents";

/** Checking, savings, and cash are money you hold. Credit is a card. */
export const accountTypes = ["checking", "savings", "credit", "cash"] as const;

export type AccountType = (typeof accountTypes)[number];

/**
 * A household ledger account.
 * Positive cents are money in. Negative cents are money out.
 * A credit balance below zero is what the household owes.
 */
export type LedgerAccount = {
  id: string;
  householdId: string;
  name: string;
  type: AccountType;
  openingBalanceCents: number;
  /** ISO time when the account left the active lists. Null while it is active. */
  archivedAt: string | null;
  /** Sum of transaction amounts. The opening balance is not included. */
  movementCents: number;
  transactionCount: number;
};

export type OpeningBalanceInput = {
  amount: string;
  /** Credit only. True stores the amount as money out. Ignored for other types. */
  owed: boolean;
};

const NAME_LIMIT = 80;

export const CREDIT_OWED_HINT =
  "Enter what you owe. Turn on Owed and type that amount as a positive number. Dollas stores it as money out, so the balance is negative. Leave Owed off when the card owes you.";

export const DELETE_BLOCKED_MESSAGE =
  "This account has transactions, so it cannot be deleted. Archive it instead. The history stays.";

export function isAccountType(value: string): value is AccountType {
  return (accountTypes as readonly string[]).includes(value);
}

function accountName(raw: string): Result<string, AccountError> {
  const name = raw.trim();
  if (name.length < 2) return err(new AccountError("Name the account."));
  if (name.length > NAME_LIMIT) return err(new AccountError("Use a shorter name."));
  return ok(name);
}

function requireHousehold<T extends { householdId: string }>(
  account: T,
  householdId: string,
): Result<T, AccountError> {
  if (householdId.trim().length === 0 || account.householdId !== householdId) {
    return err(new AccountError("That account is not in this household."));
  }
  return ok(account);
}

function centsToInput(cents: number): string {
  const negative = cents < 0;
  const absolute = Math.abs(cents);
  const text = `${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

/**
 * Fields for the opening-balance control.
 * Credit uses the Owed toggle for the sign. Other accounts keep the signed amount.
 */
export function openingBalanceFields(account: {
  type: AccountType;
  openingBalanceCents: number;
}): Result<{ amount: string; owed: boolean }, InvalidMoneyError> {
  const cents = assertCents(account.openingBalanceCents);
  if (cents.isErr()) return err(cents.error);
  if (account.type === "credit") {
    return ok({ amount: centsToInput(Math.abs(cents.value)), owed: cents.value < 0 });
  }
  return ok({ amount: centsToInput(cents.value), owed: false });
}

/** Integer cents for an opening balance, using the household sign convention. */
export function openingBalanceCents(input: {
  type: AccountType;
  amount: string;
  owed: boolean;
}): Result<Cents, InvalidMoneyError> {
  const parsed = parseDollarInput(input.amount);
  if (parsed.isErr()) return err(parsed.error);
  if (input.type !== "credit") return ok(parsed.value);
  const magnitude = Math.abs(parsed.value);
  return ok(input.owed ? -magnitude : magnitude);
}

export function defineAccount(input: {
  name: string;
  type: string;
  amount: string;
  owed: boolean;
}): Result<
  { name: string; type: AccountType; openingBalanceCents: Cents },
  AccountError | InvalidMoneyError
> {
  const name = accountName(input.name);
  if (name.isErr()) return err(name.error);
  if (!isAccountType(input.type)) return err(new AccountError("Choose an account type."));
  const opening = openingBalanceCents({ type: input.type, amount: input.amount, owed: input.owed });
  if (opening.isErr()) return err(opening.error);
  return ok({ name: name.value, type: input.type, openingBalanceCents: opening.value });
}

export function renameAccount(
  account: LedgerAccount,
  householdId: string,
  name: string,
): Result<LedgerAccount, AccountError> {
  const owned = requireHousehold(account, householdId);
  if (owned.isErr()) return err(owned.error);
  const nextName = accountName(name);
  if (nextName.isErr()) return err(nextName.error);
  return ok({ ...account, name: nextName.value });
}

/** Balance is the opening balance plus later movements. Movements stay put. */
export function accountBalanceCents(account: {
  openingBalanceCents: number;
  movementCents: number;
}): Result<Cents, InvalidMoneyError> {
  const opening = assertCents(account.openingBalanceCents);
  if (opening.isErr()) return err(opening.error);
  const movement = assertCents(account.movementCents);
  if (movement.isErr()) return err(movement.error);
  const total = opening.value + movement.value;
  if (!Number.isSafeInteger(total)) return err(new InvalidMoneyError("That amount is too large."));
  return ok(total);
}

export function editOpeningBalance(
  account: LedgerAccount,
  householdId: string,
  input: OpeningBalanceInput,
): Result<{ account: LedgerAccount; balanceCents: Cents }, AccountError | InvalidMoneyError> {
  const owned = requireHousehold(account, householdId);
  if (owned.isErr()) return err(owned.error);
  const opening = openingBalanceCents({ type: account.type, amount: input.amount, owed: input.owed });
  if (opening.isErr()) return err(opening.error);
  const next = { ...account, openingBalanceCents: opening.value };
  const balance = accountBalanceCents(next);
  if (balance.isErr()) return err(balance.error);
  return ok({ account: next, balanceCents: balance.value });
}

export function archiveAccount(
  account: LedgerAccount,
  householdId: string,
  archivedAt: string,
): Result<LedgerAccount, AccountError> {
  const owned = requireHousehold(account, householdId);
  if (owned.isErr()) return err(owned.error);
  if (account.archivedAt !== null) return ok(account);
  const stamp = archivedAt.trim();
  if (stamp.length === 0) return err(new AccountError("Could not archive that account."));
  return ok({ ...account, archivedAt: stamp });
}

export function unarchiveAccount(account: LedgerAccount, householdId: string): Result<LedgerAccount, AccountError> {
  const owned = requireHousehold(account, householdId);
  if (owned.isErr()) return err(owned.error);
  if (account.archivedAt === null) return ok(account);
  return ok({ ...account, archivedAt: null });
}

/**
 * Active lists are account pickers, the home account total, and new activity entries.
 * Archived accounts are omitted. Another household's accounts are omitted too.
 */
export function accountsForActiveLists<T extends { householdId: string; archivedAt: string | null }>(
  accounts: readonly T[],
  householdId: string,
): T[] {
  if (householdId.trim().length === 0) return [];
  return accounts.filter((account) => account.householdId === householdId && account.archivedAt === null);
}

/** History keeps every account in the household, including archived ones. */
export function accountsForHistory<T extends { householdId: string }>(
  accounts: readonly T[],
  householdId: string,
): T[] {
  if (householdId.trim().length === 0) return [];
  return accounts.filter((account) => account.householdId === householdId);
}

/** Sum of active account balances. Archived accounts and other households are left out. */
export function homeAccountTotalCents(
  accounts: readonly {
    householdId: string;
    archivedAt: string | null;
    openingBalanceCents: number;
    movementCents: number;
  }[],
  householdId: string,
): Result<Cents, InvalidMoneyError> {
  let total = 0;
  for (const account of accountsForActiveLists(accounts, householdId)) {
    const balance = accountBalanceCents(account);
    if (balance.isErr()) return err(balance.error);
    total += balance.value;
    if (!Number.isSafeInteger(total)) return err(new InvalidMoneyError("That amount is too large."));
  }
  return ok(total);
}

export function accountAcceptsNewEntry(
  account: { id: string; householdId: string; archivedAt: string | null } | null,
  householdId: string,
): Result<void, AccountError> {
  if (!account || account.householdId !== householdId || householdId.trim().length === 0) {
    return err(new AccountError("Choose an account in this household."));
  }
  if (account.archivedAt !== null) {
    return err(new AccountError("That account is archived. Unarchive it before adding transactions."));
  }
  return ok(undefined);
}

/**
 * A correction may stay on the account it already uses, even after that account is archived.
 * Moving a transaction onto some other archived account is refused.
 */
export function accountAcceptsCorrection(
  account: { id: string; householdId: string; archivedAt: string | null } | null,
  householdId: string,
  currentAccountId: string,
): Result<void, AccountError> {
  if (!account || account.householdId !== householdId || householdId.trim().length === 0) {
    return err(new AccountError("Choose an account in this household."));
  }
  if (account.archivedAt !== null && account.id !== currentAccountId) {
    return err(new AccountError("That account is archived. Unarchive it before adding transactions."));
  }
  return ok(undefined);
}

export function deleteAccount(
  account: LedgerAccount,
  householdId: string,
): Result<{ id: string }, AccountError> {
  const owned = requireHousehold(account, householdId);
  if (owned.isErr()) return err(owned.error);
  if (account.transactionCount > 0) return err(new AccountError(DELETE_BLOCKED_MESSAGE));
  return ok({ id: account.id });
}
