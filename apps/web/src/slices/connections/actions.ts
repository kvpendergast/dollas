"use server";

import {
  createQueryBankConnectionStore,
  disconnectBank,
  DomainError,
  memberFacingMessage,
  ProviderError,
} from "@dollas/domain";
import { revalidatePath } from "next/cache";
import { withActor } from "@/db/actor";
import { logError } from "@/lib/telemetry";
import { requireBooks } from "@/slices/access/guard";
import { requireBankConnectionKeys } from "./keys";
import { bankProviderRegistry } from "./registry";
import { drizzleBankConnectionQueries } from "./store";

const CONNECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function disconnectBankConnectionAction(_state: { error: string }, formData: FormData) {
  const books = await requireBooks();
  const connectionId = String(formData.get("connectionId") ?? "");
  if (!CONNECTION_ID.test(connectionId)) return { error: "That connection is not valid." };
  let keys;
  try {
    keys = requireBankConnectionKeys();
  } catch (error) {
    logError(error, { action: "disconnect-bank", householdId: books.householdId, connectionId });
    if (error instanceof DomainError) return { error: memberFacingMessage(error, "Could not disconnect that bank.") };
    return { error: "Could not disconnect that bank." };
  }
  try {
    const outcome = await withActor(books.userId, (tx) =>
      disconnectBank(
        {
          registry: bankProviderRegistry(),
          store: createQueryBankConnectionStore(drizzleBankConnectionQueries(tx)),
          keys,
        },
        { householdId: books.householdId, connectionId },
      ),
    );
    if (outcome.isErr()) {
      logError(outcome.error, {
        action: "disconnect-bank",
        householdId: books.householdId,
        connectionId,
      });
      return { error: memberFacingMessage(outcome.error, "Could not disconnect that bank.") };
    }
    if (!outcome.value.providerRevoked) {
      logError(new ProviderError("Disconnected locally. The provider did not confirm revocation."), {
        action: "disconnect-bank",
        householdId: books.householdId,
        connectionId,
      });
    }
  } catch (error) {
    logError(error, { action: "disconnect-bank", householdId: books.householdId, connectionId });
    if (error instanceof DomainError) return { error: memberFacingMessage(error, "Could not disconnect that bank.") };
    return { error: "Could not disconnect that bank." };
  }
  revalidatePath("/accounts");
  return { error: "" };
}
