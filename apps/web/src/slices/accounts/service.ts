import {
  AccountError,
  archiveAccount,
  defineAccount,
  deleteAccount,
  editOpeningBalance,
  isAccountType,
  renameAccount,
  unarchiveAccount,
  type AccountType,
  type LedgerAccount,
} from "@dollas/domain";
import { and, eq, isNull } from "drizzle-orm";
import { withActor } from "@/db/actor";
import type { AppTx } from "@/db/client";
import { ledgerAccount, transaction } from "@/db/schema";
import { logInfo } from "@/lib/telemetry";
import {
  UUID,
  failure,
  refuse,
  succeed,
  type ServiceActor,
  type ServiceResult,
  type Via,
} from "@/lib/service-result";
import type { BooksContext } from "@/slices/access/member";
import { loadAccounts, type AccountListItem } from "@/slices/books/queries";

/**
 * Account services shared by the Accounts page actions and MCP tools.
 * Money is integer cents; the page parses decimal text before it calls these.
 */
export type AccountActor = ServiceActor;
export type AccountResult<T> = ServiceResult<T>;

export type NewAccountInput = {
  name: string;
  type: string;
  /** Decimal text as a member types it, e.g. "1250.00". Parsed to integer cents. */
  opening: string;
  /** Credit only: the opening amount is owed. */
  owed: boolean;
};

export type AddedAccount = {
  id: string;
  name: string;
  type: AccountType;
  openingBalanceCents: number;
};

export type AccountEdit = {
  name: string;
  /** Decimal text, e.g. "1250.00". */
  opening: string;
  owed: boolean;
};

const NOT_HERE = "That account is not in this household.";

export async function listHouseholdAccounts(
  books: BooksContext,
  options: { includeArchived: boolean },
): Promise<ServiceResult<AccountListItem[]>> {
  try {
    const accounts = await loadAccounts(books);
    return succeed(accounts.filter((item) => options.includeArchived || !item.archivedAt));
  } catch (error) {
    return failure(error, "Could not load accounts. Try again.", { action: "list-accounts", householdId: books.householdId });
  }
}

export async function addHouseholdAccount(
  actor: AccountActor,
  input: NewAccountInput,
  via: Via = "web",
): Promise<AccountResult<AddedAccount>> {
  const defined = defineAccount({ name: input.name, type: input.type, amount: input.opening, owed: input.owed });
  if (defined.isErr()) return refuse(defined.error.message, defined.error);
  try {
    const [row] = await withActor(actor.userId, (tx) =>
      tx
        .insert(ledgerAccount)
        .values({
          householdId: actor.householdId,
          name: defined.value.name,
          type: defined.value.type,
          openingBalanceCents: defined.value.openingBalanceCents,
        })
        .returning({ id: ledgerAccount.id }),
    );
    if (!row) throw new Error("account insert returned no row");
    logInfo("Account added", { action: "create-account", via, householdId: actor.householdId });
    return succeed({
      id: row.id,
      name: defined.value.name,
      type: defined.value.type,
      openingBalanceCents: defined.value.openingBalanceCents,
    });
  } catch (error) {
    return failure(error, "Could not add that account.", { action: "create-account", via, householdId: actor.householdId });
  }
}

async function loadLedgerAccount(tx: AppTx, householdId: string, accountId: string): Promise<LedgerAccount | null> {
  const [row] = await tx
    .select()
    .from(ledgerAccount)
    .where(and(eq(ledgerAccount.id, accountId), eq(ledgerAccount.householdId, householdId)));
  if (!row || !isAccountType(row.type)) return null;
  const movements = await tx
    .select({ amountCents: transaction.amountCents })
    .from(transaction)
    .where(
      and(eq(transaction.accountId, accountId), eq(transaction.householdId, householdId), isNull(transaction.deletedAt)),
    );
  let movementCents = 0;
  for (const movement of movements) movementCents += movement.amountCents;
  return {
    id: row.id,
    householdId: row.householdId,
    name: row.name,
    type: row.type,
    openingBalanceCents: row.openingBalanceCents,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    movementCents,
    transactionCount: movements.length,
  };
}

/** Loads the account, lets `change` decide, and writes in one household transaction. */
async function changeAccount<T>(
  actor: AccountActor,
  accountId: string,
  action: string,
  fallback: string,
  via: Via,
  change: (tx: AppTx, current: LedgerAccount) => Promise<T>,
): Promise<AccountResult<T>> {
  if (!UUID.test(accountId)) return refuse(NOT_HERE);
  try {
    const value = await withActor(actor.userId, async (tx) => {
      const current = await loadLedgerAccount(tx, actor.householdId, accountId);
      if (!current) throw new AccountError(NOT_HERE);
      return change(tx, current);
    });
    logInfo("Account changed", { action, via, householdId: actor.householdId });
    return succeed(value);
  } catch (error) {
    return failure(error, fallback, { action, via, householdId: actor.householdId, accountId });
  }
}

function thisAccount(actor: AccountActor, accountId: string) {
  return and(eq(ledgerAccount.id, accountId), eq(ledgerAccount.householdId, actor.householdId));
}

export async function updateHouseholdAccount(
  actor: AccountActor,
  accountId: string,
  edit: AccountEdit,
  via: Via = "web",
): Promise<AccountResult<{ id: string; name: string; openingBalanceCents: number }>> {
  return changeAccount(actor, accountId, "update-account", "Could not save that account.", via, async (tx, current) => {
    const renamed = renameAccount(current, actor.householdId, edit.name);
    if (renamed.isErr()) throw renamed.error;
    const edited = editOpeningBalance(renamed.value, actor.householdId, { amount: edit.opening, owed: edit.owed });
    if (edited.isErr()) throw edited.error;
    const updated = await tx
      .update(ledgerAccount)
      .set({ name: edited.value.account.name, openingBalanceCents: edited.value.account.openingBalanceCents })
      .where(thisAccount(actor, accountId))
      .returning({ id: ledgerAccount.id });
    if (updated.length === 0) throw new AccountError(NOT_HERE);
    return { id: accountId, name: edited.value.account.name, openingBalanceCents: edited.value.account.openingBalanceCents };
  });
}

export async function archiveHouseholdAccount(
  actor: AccountActor,
  accountId: string,
  via: Via = "web",
): Promise<AccountResult<{ id: string; archivedAt: string }>> {
  return changeAccount(actor, accountId, "archive-account", "Could not archive that account.", via, async (tx, current) => {
    const archived = archiveAccount(current, actor.householdId, new Date().toISOString());
    if (archived.isErr()) throw archived.error;
    const stamp = archived.value.archivedAt;
    if (!stamp) throw new AccountError("Could not archive that account.");
    const updated = await tx
      .update(ledgerAccount)
      .set({ archivedAt: new Date(stamp) })
      .where(thisAccount(actor, accountId))
      .returning({ id: ledgerAccount.id });
    if (updated.length === 0) throw new AccountError(NOT_HERE);
    return { id: accountId, archivedAt: stamp };
  });
}

export async function unarchiveHouseholdAccount(
  actor: AccountActor,
  accountId: string,
  via: Via = "web",
): Promise<AccountResult<{ id: string }>> {
  return changeAccount(actor, accountId, "unarchive-account", "Could not unarchive that account.", via, async (tx, current) => {
    const restored = unarchiveAccount(current, actor.householdId);
    if (restored.isErr()) throw restored.error;
    const updated = await tx
      .update(ledgerAccount)
      .set({ archivedAt: null })
      .where(thisAccount(actor, accountId))
      .returning({ id: ledgerAccount.id });
    if (updated.length === 0) throw new AccountError(NOT_HERE);
    return { id: accountId };
  });
}

/** Deletes an account the domain allows deleting (no transactions). The caller has confirmed. */
export async function deleteHouseholdAccount(
  actor: AccountActor,
  accountId: string,
  via: Via = "web",
): Promise<AccountResult<{ id: string; name: string }>> {
  return changeAccount(actor, accountId, "delete-account", "Could not delete that account.", via, async (tx, current) => {
    const decision = deleteAccount(current, actor.householdId);
    if (decision.isErr()) throw decision.error;
    const removed = await tx
      .delete(ledgerAccount)
      .where(thisAccount(actor, accountId))
      .returning({ id: ledgerAccount.id });
    if (removed.length === 0) throw new AccountError(NOT_HERE);
    return { id: accountId, name: current.name };
  });
}
