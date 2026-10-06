import { describe, expect, it } from "vitest";
import { ProviderSyncError } from "../errors";
import { providerTransactionFingerprint } from "./provider";
import type { ProviderAccount, ProviderTransaction } from "./provider";
import { defaultTransactionsSince, planBankSync, type SyncLedgerAccount } from "./sync";

const householdId = "house-a";

const checking: ProviderAccount = {
  providerAccountId: "act-checking",
  name: "Checking",
  type: "checking",
  currency: "USD",
  balanceCents: 10_000,
};

const rent: ProviderTransaction = {
  providerTransactionId: "txn-rent",
  providerAccountId: "act-checking",
  occurredOn: "2026-03-02",
  payee: "Rent",
  amountCents: -8_000,
  pending: false,
};

function fingerprint(id: string): string {
  const value = providerTransactionFingerprint("simplefin", id);
  if (value.isErr()) throw value.error;
  return value.value;
}

describe("planBankSync", () => {
  it("matches one ledger account by name and does not invent a second", () => {
    const ledger: SyncLedgerAccount = {
      id: "ledger-checking",
      householdId,
      name: "checking",
      type: "checking",
      archivedAt: null,
    };
    const plan = planBankSync({
      providerId: "simplefin",
      householdId,
      accounts: [checking],
      transactions: [rent],
      ledgerAccounts: [ledger],
      links: [],
      imported: [],
      rules: [],
      fallbacks: { incomeCategoryId: "cat-income", expenseCategoryId: "cat-expense" },
    });
    if (plan.isErr()) throw plan.error;
    expect(plan.value.accounts).toEqual([
      {
        kind: "link",
        providerAccountId: "act-checking",
        ledgerAccountId: "ledger-checking",
        currency: "USD",
        balanceCents: 10_000,
      },
    ]);
    expect(plan.value.transactions).toHaveLength(1);
    expect(plan.value.transactions[0]?.fingerprint).toBe("bank:simplefin:txn-rent");
    expect(plan.value.transactions[0]?.categoryId).toBe("cat-expense");
  });

  it("asks the member to rename when two accounts share a name", () => {
    const ledger = (id: string): SyncLedgerAccount => ({
      id,
      householdId,
      name: "Checking",
      type: "checking",
      archivedAt: null,
    });
    const plan = planBankSync({
      providerId: "simplefin",
      householdId,
      accounts: [checking],
      transactions: [],
      ledgerAccounts: [ledger("one"), ledger("two")],
      links: [],
      imported: [],
      rules: [],
    });
    expect(plan.isErr()).toBe(true);
    if (plan.isOk()) return;
    expect(plan.error).toBeInstanceOf(ProviderSyncError);
    expect(plan.error.message).toContain("Rename one");
  });

  it("does not plan a deleted transaction or a repeat of one already imported", () => {
    const created = planBankSync({
      providerId: "simplefin",
      householdId,
      accounts: [checking],
      transactions: [rent],
      ledgerAccounts: [],
      links: [],
      imported: [{ householdId, fingerprint: fingerprint("txn-rent"), deletedAt: "2026-04-02T00:00:00.000Z" }],
      rules: [],
    });
    if (created.isErr()) throw created.error;
    expect(created.value.transactions).toEqual([]);
    expect(created.value.accounts[0]?.kind).toBe("create");
    if (created.value.accounts[0]?.kind !== "create") return;
    expect(created.value.accounts[0].openingBalanceCents).toBe(10_000);

    const repeat = planBankSync({
      providerId: "simplefin",
      householdId,
      accounts: [checking],
      transactions: [rent, { ...rent, providerTransactionId: "txn-new", amountCents: -100 }],
      ledgerAccounts: [],
      links: [{ providerAccountId: "act-checking", ledgerAccountId: "ledger-checking" }],
      imported: [
        { householdId, fingerprint: fingerprint("txn-rent"), deletedAt: null },
        { householdId, fingerprint: fingerprint("txn-new"), deletedAt: null },
      ],
      rules: [],
    });
    if (repeat.isErr()) throw repeat.error;
    expect(repeat.value.transactions).toEqual([]);
    expect(repeat.value.accounts[0]?.kind).toBe("update");
  });

  it("leaves pending transactions out of the plan", () => {
    const plan = planBankSync({
      providerId: "simplefin",
      householdId,
      accounts: [checking],
      transactions: [{ ...rent, pending: true }],
      ledgerAccounts: [],
      links: [],
      imported: [],
      rules: [],
    });
    if (plan.isErr()) throw plan.error;
    expect(plan.value.transactions).toEqual([]);
    if (plan.value.accounts[0]?.kind !== "create") throw new Error("create");
    expect(plan.value.accounts[0].openingBalanceCents).toBe(10_000);
  });
});

describe("defaultTransactionsSince", () => {
  it("is a civil date ninety days earlier", () => {
    expect(defaultTransactionsSince(new Date("2026-04-06T15:00:00.000Z"))).toBe("2026-01-06");
  });
});
