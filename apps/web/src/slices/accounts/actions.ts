"use server";

import {
  AccountError,
  DomainError,
  archiveAccount,
  defineAccount,
  deleteAccount,
  editOpeningBalance,
  isAccountType,
  renameAccount,
  unarchiveAccount,
  type LedgerAccount,
} from "@dollas/domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withActor } from "@/db/actor";
import type { AppTx } from "@/db/client";
import { ledgerAccount, transaction } from "@/db/schema";
import { logError } from "@/lib/telemetry";
import { requireBooks } from "@/slices/access/guard";

const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function revalidateAccountViews() {
  revalidatePath("/accounts");
  revalidatePath("/");
  revalidatePath("/activity");
}

function owedFromForm(formData: FormData): boolean {
  return String(formData.get("owed") ?? "") === "yes";
}

function failure(error: unknown, fallback: string, attributes: Record<string, string>): string {
  logError(error, attributes);
  if (error instanceof DomainError) return error.message;
  return fallback;
}

async function loadLedgerAccount(
  tx: AppTx,
  householdId: string,
  accountId: string,
): Promise<LedgerAccount | null> {
  const [row] = await tx
    .select()
    .from(ledgerAccount)
    .where(and(eq(ledgerAccount.id, accountId), eq(ledgerAccount.householdId, householdId)));
  if (!row || !isAccountType(row.type)) return null;
  const movements = await tx
    .select({ amountCents: transaction.amountCents })
    .from(transaction)
    .where(and(eq(transaction.accountId, accountId), eq(transaction.householdId, householdId)));
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

export async function createAccountAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const defined = defineAccount({
    name: String(formData.get("name") ?? ""),
    type: String(formData.get("type") ?? ""),
    amount: String(formData.get("opening") ?? "0"),
    owed: owedFromForm(formData),
  });
  if (defined.isErr()) return { error: defined.error.message };
  try {
    await withActor(books.userId, (tx) =>
      tx.insert(ledgerAccount).values({
        householdId: books.householdId,
        name: defined.value.name,
        type: defined.value.type,
        openingBalanceCents: defined.value.openingBalanceCents,
      }),
    );
  } catch (error) {
    return { error: failure(error, "Could not add that account.", { action: "create-account", householdId: books.householdId }) };
  }
  revalidateAccountViews();
  return { error: "" };
}

export async function updateAccountAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const accountId = String(formData.get("accountId") ?? "");
  if (!ACCOUNT_ID.test(accountId)) return { error: "That account is not in this household." };
  try {
    await withActor(books.userId, async (tx) => {
      const current = await loadLedgerAccount(tx, books.householdId, accountId);
      if (!current) throw new AccountError("That account is not in this household.");
      const renamed = renameAccount(current, books.householdId, String(formData.get("name") ?? ""));
      if (renamed.isErr()) throw renamed.error;
      const edited = editOpeningBalance(renamed.value, books.householdId, {
        amount: String(formData.get("opening") ?? ""),
        owed: owedFromForm(formData),
      });
      if (edited.isErr()) throw edited.error;
      const updated = await tx
        .update(ledgerAccount)
        .set({
          name: edited.value.account.name,
          openingBalanceCents: edited.value.account.openingBalanceCents,
        })
        .where(and(eq(ledgerAccount.id, accountId), eq(ledgerAccount.householdId, books.householdId)))
        .returning({ id: ledgerAccount.id });
      if (updated.length === 0) throw new AccountError("That account is not in this household.");
    });
  } catch (error) {
    return {
      error: failure(error, "Could not save that account.", {
        action: "update-account",
        householdId: books.householdId,
        accountId,
      }),
    };
  }
  revalidateAccountViews();
  return { error: "" };
}

export async function archiveAccountAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const accountId = String(formData.get("accountId") ?? "");
  if (!ACCOUNT_ID.test(accountId)) return { error: "That account is not in this household." };
  try {
    await withActor(books.userId, async (tx) => {
      const current = await loadLedgerAccount(tx, books.householdId, accountId);
      if (!current) throw new AccountError("That account is not in this household.");
      const archived = archiveAccount(current, books.householdId, new Date().toISOString());
      if (archived.isErr()) throw archived.error;
      const stamp = archived.value.archivedAt;
      if (!stamp) throw new AccountError("Could not archive that account.");
      const updated = await tx
        .update(ledgerAccount)
        .set({ archivedAt: new Date(stamp) })
        .where(and(eq(ledgerAccount.id, accountId), eq(ledgerAccount.householdId, books.householdId)))
        .returning({ id: ledgerAccount.id });
      if (updated.length === 0) throw new AccountError("That account is not in this household.");
    });
  } catch (error) {
    return {
      error: failure(error, "Could not archive that account.", {
        action: "archive-account",
        householdId: books.householdId,
        accountId,
      }),
    };
  }
  revalidateAccountViews();
  return { error: "" };
}

export async function unarchiveAccountAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const accountId = String(formData.get("accountId") ?? "");
  if (!ACCOUNT_ID.test(accountId)) return { error: "That account is not in this household." };
  try {
    await withActor(books.userId, async (tx) => {
      const current = await loadLedgerAccount(tx, books.householdId, accountId);
      if (!current) throw new AccountError("That account is not in this household.");
      const restored = unarchiveAccount(current, books.householdId);
      if (restored.isErr()) throw restored.error;
      const updated = await tx
        .update(ledgerAccount)
        .set({ archivedAt: null })
        .where(and(eq(ledgerAccount.id, accountId), eq(ledgerAccount.householdId, books.householdId)))
        .returning({ id: ledgerAccount.id });
      if (updated.length === 0) throw new AccountError("That account is not in this household.");
    });
  } catch (error) {
    return {
      error: failure(error, "Could not unarchive that account.", {
        action: "unarchive-account",
        householdId: books.householdId,
        accountId,
      }),
    };
  }
  revalidateAccountViews();
  return { error: "" };
}

export async function deleteAccountAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const accountId = String(formData.get("accountId") ?? "");
  if (!ACCOUNT_ID.test(accountId)) return { error: "That account is not in this household." };
  if (String(formData.get("confirm") ?? "") !== "yes") {
    return { error: "Confirm before deleting this account." };
  }
  try {
    await withActor(books.userId, async (tx) => {
      const current = await loadLedgerAccount(tx, books.householdId, accountId);
      if (!current) throw new AccountError("That account is not in this household.");
      const decision = deleteAccount(current, books.householdId);
      if (decision.isErr()) throw decision.error;
      const removed = await tx
        .delete(ledgerAccount)
        .where(and(eq(ledgerAccount.id, accountId), eq(ledgerAccount.householdId, books.householdId)))
        .returning({ id: ledgerAccount.id });
      if (removed.length === 0) throw new AccountError("That account is not in this household.");
    });
  } catch (error) {
    return {
      error: failure(error, "Could not delete that account.", {
        action: "delete-account",
        householdId: books.householdId,
        accountId,
      }),
    };
  }
  revalidateAccountViews();
  return { error: "" };
}
