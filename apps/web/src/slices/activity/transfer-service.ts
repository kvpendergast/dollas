import { TRANSFERS_CATEGORY, defineTransactionEntry } from "@dollas/domain";
import { and, eq } from "drizzle-orm";
import { withActor } from "@/db/actor";
import type { AppTx } from "@/db/client";
import { category, ledgerAccount, transaction, transactionSplit } from "@/db/schema";
import { logInfo } from "@/lib/telemetry";
import { UUID, failure, refuse, succeed, type ServiceActor, type ServiceResult, type Via } from "@/lib/service-result";
import { linkRecurringMatches } from "@/slices/recurring/store";
import { requireHouseholdTargets } from "./transactions";

/**
 * Move money between two of the household's own accounts (PEN-280): one
 * transaction out of the source and one into the destination, both in the
 * Transfers category (made on first use), written together or not at all.
 * Transfers are neither income nor spending in the dashboard and the plan.
 */

const KNOWN = ["Choose categories from this household."];

export type SavedTransfer = {
  fromTransactionId: string;
  toTransactionId: string;
  categoryId: string;
  fromAccountName: string;
  toAccountName: string;
  amountCents: number;
  occurredOn: string;
};

/** The household's Transfers category (kind transfer), created if it has none. */
export async function ensureTransfersCategory(tx: AppTx, householdId: string): Promise<string> {
  const rows = await tx
    .select({ id: category.id, name: category.name })
    .from(category)
    .where(and(eq(category.householdId, householdId), eq(category.kind, TRANSFERS_CATEGORY.kind)));
  const found = rows.find((row) => row.name.trim().toLowerCase() === TRANSFERS_CATEGORY.name.toLowerCase()) ?? rows[0];
  if (found) return found.id;
  const [made] = await tx
    .insert(category)
    .values({ householdId, name: TRANSFERS_CATEGORY.name, kind: TRANSFERS_CATEGORY.kind, sortOrder: 1000 })
    .returning({ id: category.id });
  if (!made) throw new Error("Could not create the Transfers category.");
  return made.id;
}

export async function createHouseholdTransfer(
  actor: ServiceActor,
  input: { fromAccountId: string; toAccountId: string; amountCents: number; occurredOn: string },
  via: Via = "web",
): Promise<ServiceResult<SavedTransfer>> {
  if (!UUID.test(input.fromAccountId) || !UUID.test(input.toAccountId)) return refuse("Choose two accounts from this household.");
  if (input.fromAccountId === input.toAccountId) return refuse("Choose two different accounts.");
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) return refuse("Enter an amount greater than zero.");
  try {
    const saved = await withActor(actor.userId, async (tx) => {
      const accounts = await tx
        .select({ id: ledgerAccount.id, name: ledgerAccount.name })
        .from(ledgerAccount)
        .where(eq(ledgerAccount.householdId, actor.householdId));
      const from = accounts.find((row) => row.id === input.fromAccountId);
      const to = accounts.find((row) => row.id === input.toAccountId);
      if (!from || !to) throw new Error("Choose two accounts from this household.");
      const categoryId = await ensureTransfersCategory(tx, actor.householdId);
      const sides = [
        { accountId: from.id, payee: `Transfer to ${to.name}`.slice(0, 200), amountCents: -input.amountCents },
        { accountId: to.id, payee: `Transfer from ${from.name}`.slice(0, 200), amountCents: input.amountCents },
      ];
      const ids: string[] = [];
      for (const side of sides) {
        const defined = defineTransactionEntry({
          accountId: side.accountId,
          occurredOn: input.occurredOn,
          payee: side.payee,
          amountCents: side.amountCents,
          splits: [{ categoryId, amountCents: side.amountCents }],
        });
        if (defined.isErr()) throw defined.error;
        const entry = defined.value;
        await requireHouseholdTargets(tx, actor.householdId, entry, { kind: "new" });
        const [row] = await tx
          .insert(transaction)
          .values({
            householdId: actor.householdId,
            accountId: entry.accountId,
            occurredOn: entry.occurredOn,
            payee: entry.payee,
            amountCents: entry.amountCents,
          })
          .returning({ id: transaction.id });
        if (!row) throw new Error("transaction insert returned no row");
        await tx.insert(transactionSplit).values(
          entry.splits.map((split) => ({
            transactionId: row.id,
            householdId: actor.householdId,
            categoryId: split.categoryId,
            amountCents: split.amountCents,
          })),
        );
        ids.push(row.id);
      }
      await linkRecurringMatches(tx, actor.householdId, { transactionIds: ids });
      return {
        fromTransactionId: ids[0] ?? "",
        toTransactionId: ids[1] ?? "",
        categoryId,
        fromAccountName: from.name,
        toAccountName: to.name,
        amountCents: input.amountCents,
        occurredOn: input.occurredOn,
      };
    });
    logInfo("Transfer added", { action: "create-transfer", via, householdId: actor.householdId });
    return succeed(saved);
  } catch (error) {
    return failure(
      error,
      "Could not save that transfer.",
      { action: "create-transfer", via, householdId: actor.householdId },
      [...KNOWN, "Choose two accounts from this household."],
    );
  }
}
