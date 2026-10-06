"use server";

import {
  connectBank,
  createQueryBankConnectionStore,
  defaultTransactionsSince,
  isIsoDate,
  SIMPLEFIN_PROVIDER_ID,
} from "@dollas/domain";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { withActor } from "@/db/actor";
import { bankConnection } from "@/db/schema";
import { logError, logInfo } from "@/lib/telemetry";
import { requireBooks } from "@/slices/access/guard";
import { requireBankConnectionKeys } from "./keys";
import { memberBankMessage } from "./messages";
import { bankProviderRegistry } from "./registry";
import {
  createPlaidLinkToken,
  disconnectBankConnection,
  exchangePlaidPublicToken,
  syncBankConnection,
  type BankServiceResult,
} from "./service";
import { drizzleBankConnectionQueries } from "./store";

export type BankFormState = { error: string; message: string };

export async function linkSimpleFinAction(_state: BankFormState, formData: FormData): Promise<BankFormState> {
  const books = await requireBooks();
  const token = String(formData.get("token") ?? "");
  const label = String(formData.get("label") ?? "").trim();
  const sinceRaw = String(formData.get("since") ?? "").trim();
  let since = defaultTransactionsSince(new Date());
  if (sinceRaw) {
    if (!isIsoDate(sinceRaw)) return { error: "Use a start date like 2026-01-01.", message: "" };
    since = sinceRaw;
  }
  let keys;
  try {
    keys = requireBankConnectionKeys();
  } catch (error) {
    logError(error, { action: "link-simplefin", householdId: books.householdId });
    return { error: memberBankMessage(error, "Could not link that bank."), message: "" };
  }
  logInfo("simplefin.claim.started", { action: "link-simplefin", householdId: books.householdId });
  try {
    const outcome = await withActor(books.userId, async (tx) => {
      const connected = await connectBank(
        {
          registry: bankProviderRegistry(),
          store: createQueryBankConnectionStore(drizzleBankConnectionQueries(tx)),
          keys,
        },
        {
          householdId: books.householdId,
          providerId: SIMPLEFIN_PROVIDER_ID,
          setup: { token },
          label: label || undefined,
        },
      );
      if (connected.isErr()) return connected;
      await tx
        .update(bankConnection)
        .set({ transactionsSince: since })
        .where(and(eq(bankConnection.id, connected.value.id), eq(bankConnection.householdId, books.householdId)));
      return connected;
    });
    if (outcome.isErr()) {
      logError(outcome.error, { action: "link-simplefin", householdId: books.householdId });
      return { error: memberBankMessage(outcome.error, "Could not link that bank."), message: "" };
    }
    logInfo("simplefin.claim.finished", {
      action: "link-simplefin",
      householdId: books.householdId,
      connectionId: outcome.value.id,
    });
  } catch (error) {
    logError(error, { action: "link-simplefin", householdId: books.householdId });
    return { error: memberBankMessage(error, "Could not link that bank."), message: "" };
  }
  revalidateBooks();
  return { error: "", message: "SimpleFIN is linked. Sync to bring in accounts and transactions." };
}

export async function syncBankConnectionAction(_state: BankFormState, formData: FormData): Promise<BankFormState> {
  const books = await requireBooks();
  const connectionId = String(formData.get("connectionId") ?? "");
  const outcome = await syncBankConnection(books, connectionId);
  if (!outcome.ok) return { error: shown(outcome, "Could not sync that bank."), message: "" };
  revalidateBooks();
  return { error: "", message: syncMessage(outcome.value) };
}

export async function disconnectBankConnectionAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const connectionId = String(formData.get("connectionId") ?? "");
  const outcome = await disconnectBankConnection(books, connectionId);
  if (!outcome.ok) return { error: shown(outcome, "Could not disconnect that bank.") };
  revalidatePath("/accounts");
  return { error: "" };
}

export async function createPlaidLinkTokenAction(sinceRaw: string): Promise<{ error: string; linkToken: string }> {
  const books = await requireBooks();
  const created = await createPlaidLinkToken(books, sinceRaw);
  if (!created.ok) return { error: shown(created, "Could not link that bank."), linkToken: "" };
  return { error: "", linkToken: created.value.linkToken };
}

export async function linkPlaidAction(publicToken: string, label: string, sinceRaw: string): Promise<BankFormState> {
  const books = await requireBooks();
  const linked = await exchangePlaidPublicToken(books, publicToken, label, sinceRaw);
  if (!linked.ok) return { error: shown(linked, "Could not link that bank."), message: "" };
  revalidateBooks();
  return { error: "", message: "Plaid is linked. Sync to bring in accounts and transactions." };
}

function shown(outcome: Extract<BankServiceResult<unknown>, { ok: false }>, fallback: string): string {
  return outcome.memberMessage ?? memberBankMessage(outcome.error, fallback);
}

function syncMessage(written: { accounts: number; transactions: number; updated: number; removed: number }): string {
  const accountLabel = written.accounts === 1 ? "account" : "accounts";
  if (written.transactions === 0 && written.updated === 0 && written.removed === 0) {
    return `Updated ${written.accounts} ${accountLabel}. No new transactions.`;
  }
  const parts = [`Synced ${written.accounts} ${accountLabel}`];
  if (written.transactions > 0) {
    parts.push(`added ${written.transactions} ${written.transactions === 1 ? "transaction" : "transactions"}`);
  }
  if (written.updated > 0) parts.push(`updated ${written.updated}`);
  if (written.removed > 0) parts.push(`hid ${written.removed} removed by the bank`);
  if (parts.length === 1) return `${parts[0]}.`;
  return `${parts[0]} and ${parts.slice(1).join(", ")}.`;
}

function revalidateBooks() {
  revalidatePath("/accounts");
  revalidatePath("/activity");
  revalidatePath("/");
  revalidatePath("/plan");
  revalidatePath("/history");
  revalidatePath("/projection");
}
