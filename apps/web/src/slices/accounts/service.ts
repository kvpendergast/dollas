import { DomainError, defineAccount, memberFacingMessage, type AccountType } from "@dollas/domain";
import { withActor } from "@/db/actor";
import { ledgerAccount } from "@/db/schema";
import { logError, logInfo } from "@/lib/telemetry";

/**
 * Account services shared by page actions and MCP tools.
 * MCP-able: addHouseholdAccount.
 */
export type AccountActor = {
  userId: string;
  householdId: string;
};

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

export type AccountResult<T> = { ok: true; value: T } | { ok: false; error: unknown; memberMessage: string };

const ADD_FAILED = "Could not add that account.";

export async function addHouseholdAccount(
  actor: AccountActor,
  input: NewAccountInput,
  via: "web" | "mcp" = "web",
): Promise<AccountResult<AddedAccount>> {
  const defined = defineAccount({ name: input.name, type: input.type, amount: input.opening, owed: input.owed });
  if (defined.isErr()) return { ok: false, error: defined.error, memberMessage: defined.error.message };
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
    return {
      ok: true,
      value: {
        id: row.id,
        name: defined.value.name,
        type: defined.value.type,
        openingBalanceCents: defined.value.openingBalanceCents,
      },
    };
  } catch (error) {
    logError(error, { action: "create-account", via, householdId: actor.householdId });
    return {
      ok: false,
      error,
      memberMessage: error instanceof DomainError ? error.message : memberFacingMessage(error, ADD_FAILED),
    };
  }
}
