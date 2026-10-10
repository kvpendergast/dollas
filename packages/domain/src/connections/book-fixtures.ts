import type { BankIdentity, SyncBookTransaction } from "./sync";

/** Test fixtures for the sync planners. Not exported from the package. */
export function legacyBookRow(householdId: string, fingerprint: string, deletedAt: string | null = null): SyncBookTransaction {
  return {
    id: `row-${fingerprint.split(":").pop()}`,
    householdId,
    accountId: "ledger-legacy",
    occurredOn: "2026-03-01",
    payee: "Legacy",
    amountCents: -1,
    deletedAt,
    createdAt: "2026-03-01T00:00:00.000Z",
    bank: null,
    importFingerprint: fingerprint,
    matched: false,
  };
}

export function bankBookRow(
  householdId: string,
  bank: BankIdentity,
  extra: Partial<SyncBookTransaction> = {},
): SyncBookTransaction {
  return {
    id: `row-${bank.providerTransactionId}`,
    householdId,
    accountId: "ledger-checking",
    occurredOn: "2026-03-02",
    payee: "Bank row",
    amountCents: -1_000,
    deletedAt: null,
    createdAt: "2026-03-02T00:00:00.000Z",
    bank,
    importFingerprint: null,
    matched: false,
    ...extra,
  };
}

export function bookRow(householdId: string, id: string, extra: Partial<SyncBookTransaction> = {}): SyncBookTransaction {
  return {
    id,
    householdId,
    accountId: "ledger-checking",
    occurredOn: "2026-03-02",
    payee: "Book row",
    amountCents: -1_000,
    deletedAt: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    bank: null,
    importFingerprint: null,
    matched: false,
    ...extra,
  };
}
