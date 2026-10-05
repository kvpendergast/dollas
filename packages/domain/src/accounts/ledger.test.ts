import { describe, expect, it } from "vitest";
import { AccountError, InvalidMoneyError } from "../errors";
import {
  CREDIT_OWED_HINT,
  DELETE_BLOCKED_MESSAGE,
  accountAcceptsCorrection,
  accountAcceptsNewEntry,
  accountBalanceCents,
  accountsForActiveLists,
  accountsForHistory,
  archiveAccount,
  defineAccount,
  deleteAccount,
  editOpeningBalance,
  homeAccountTotalCents,
  openingBalanceCents,
  renameAccount,
  unarchiveAccount,
  type LedgerAccount,
} from "./ledger";

const householdId = "house-maple";

function account(overrides: Partial<LedgerAccount> = {}): LedgerAccount {
  return {
    id: "acct-checking",
    householdId,
    name: "Checking",
    type: "checking",
    openingBalanceCents: 245_000,
    archivedAt: null,
    movementCents: -18_000,
    transactionCount: 4,
    ...overrides,
  };
}

describe("renameAccount", () => {
  it("trims a new name and leaves the balance alone", () => {
    const renamed = renameAccount(account(), householdId, "  Everyday checking  ")._unsafeUnwrap();
    expect(renamed.name).toBe("Everyday checking");
    expect(renamed.openingBalanceCents).toBe(245_000);
    expect(renamed.movementCents).toBe(-18_000);
  });

  it("rejects a blank name", () => {
    const result = renameAccount(account(), householdId, "  ");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(AccountError);
    expect(result._unsafeUnwrapErr().message).toBe("Name the account.");
  });
});

describe("editOpeningBalance", () => {
  it("moves the balance by the opening-balance delta and leaves movements alone", () => {
    const current = account();
    const before = accountBalanceCents(current)._unsafeUnwrap();
    const edited = editOpeningBalance(current, householdId, { amount: "2500.00", owed: false })._unsafeUnwrap();
    expect(edited.account.movementCents).toBe(current.movementCents);
    expect(edited.account.transactionCount).toBe(current.transactionCount);
    expect(edited.account.openingBalanceCents).toBe(250_000);
    expect(edited.balanceCents).toBe(250_000 - 18_000);
    expect(edited.balanceCents - before).toBe(250_000 - 245_000);
  });

  it("stores an owed credit opening balance as negative cents", () => {
    const card = account({
      id: "acct-visa",
      name: "Visa",
      type: "credit",
      openingBalanceCents: 0,
      movementCents: -4_200,
      transactionCount: 2,
    });
    const edited = editOpeningBalance(card, householdId, { amount: "440.25", owed: true })._unsafeUnwrap();
    expect(edited.account.openingBalanceCents).toBe(-44_025);
    expect(edited.balanceCents).toBe(-44_025 - 4_200);
    expect(CREDIT_OWED_HINT).toMatch(/Owed/);
    expect(CREDIT_OWED_HINT).toMatch(/negative/);
  });

  it("stores a credit balance the issuer owes you as positive cents", () => {
    const card = account({ type: "credit", openingBalanceCents: -100, movementCents: 0, transactionCount: 0 });
    const edited = editOpeningBalance(card, householdId, { amount: "20.00", owed: false })._unsafeUnwrap();
    expect(edited.account.openingBalanceCents).toBe(2_000);
    expect(edited.balanceCents).toBe(2_000);
  });

  it("ignores the Owed toggle on checking, savings, and cash", () => {
    for (const type of ["checking", "savings", "cash"] as const) {
      const edited = editOpeningBalance(account({ type, transactionCount: 0 }), householdId, {
        amount: "10.00",
        owed: true,
      })._unsafeUnwrap();
      expect(edited.account.openingBalanceCents).toBe(1_000);
    }
  });

  it("rejects an amount that is not dollars and cents", () => {
    const result = editOpeningBalance(account(), householdId, { amount: "12.345", owed: false });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(InvalidMoneyError);
  });
});

describe("openingBalanceCents", () => {
  it("uses the absolute amount and the Owed toggle for credit", () => {
    expect(openingBalanceCents({ type: "credit", amount: "-125.40", owed: true })._unsafeUnwrap()).toBe(-12_540);
    expect(openingBalanceCents({ type: "credit", amount: "-125.40", owed: false })._unsafeUnwrap()).toBe(12_540);
  });
});

describe("defineAccount", () => {
  it("defines a credit account from the Owed toggle", () => {
    expect(
      defineAccount({ name: " Visa ", type: "credit", amount: "80.00", owed: true })._unsafeUnwrap(),
    ).toEqual({
      name: "Visa",
      type: "credit",
      openingBalanceCents: -8_000,
    });
  });
});

describe("archive and unarchive", () => {
  it("removes an account from active lists and the home total, then puts it back", () => {
    const savings = account({
      id: "acct-savings",
      name: "Savings",
      type: "savings",
      openingBalanceCents: 820_000,
      movementCents: 0,
      transactionCount: 0,
    });
    const checking = account();
    const archived = archiveAccount(checking, householdId, "2026-10-05T12:00:00.000Z")._unsafeUnwrap();
    expect(archived.archivedAt).toBe("2026-10-05T12:00:00.000Z");
    expect(accountsForActiveLists([archived, savings], householdId).map((row) => row.id)).toEqual(["acct-savings"]);
    expect(accountsForHistory([archived, savings], householdId).map((row) => row.id)).toEqual([
      "acct-checking",
      "acct-savings",
    ]);
    expect(homeAccountTotalCents([archived, savings], householdId)._unsafeUnwrap()).toBe(820_000);
    expect(accountAcceptsNewEntry(archived, householdId).isErr()).toBe(true);
    expect(accountAcceptsCorrection(archived, householdId, archived.id).isOk()).toBe(true);
    expect(accountAcceptsCorrection(archived, householdId, savings.id).isErr()).toBe(true);

    const again = archiveAccount(archived, householdId, "2026-11-01T00:00:00.000Z")._unsafeUnwrap();
    expect(again.archivedAt).toBe(archived.archivedAt);

    const restored = unarchiveAccount(archived, householdId)._unsafeUnwrap();
    expect(restored.archivedAt).toBeNull();
    expect(accountsForActiveLists([restored, savings], householdId).map((row) => row.id)).toEqual([
      "acct-checking",
      "acct-savings",
    ]);
    expect(homeAccountTotalCents([restored, savings], householdId)._unsafeUnwrap()).toBe(
      245_000 - 18_000 + 820_000,
    );
    expect(accountAcceptsNewEntry(restored, householdId).isOk()).toBe(true);
  });
});

describe("deleteAccount", () => {
  it("refuses when the account has transactions", () => {
    const result = deleteAccount(account({ transactionCount: 1 }), householdId);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(AccountError);
    expect(result._unsafeUnwrapErr().message).toBe(DELETE_BLOCKED_MESSAGE);
  });

  it("deletes an account with no transactions", () => {
    const empty = account({ id: "acct-savings", transactionCount: 0, movementCents: 0 });
    expect(deleteAccount(empty, householdId)._unsafeUnwrap()).toEqual({ id: "acct-savings" });
  });
});

describe("household isolation", () => {
  it("does not rename, rebalance, archive, unarchive, or delete another household's account", () => {
    const maple = account();
    const otherId = "house-other";
    const results = [
      renameAccount(maple, otherId, "Stolen"),
      editOpeningBalance(maple, otherId, { amount: "1.00", owed: false }),
      archiveAccount(maple, otherId, "2026-10-05T00:00:00.000Z"),
      unarchiveAccount({ ...maple, archivedAt: "2026-10-01T00:00:00.000Z" }, otherId),
      deleteAccount({ ...maple, transactionCount: 0 }, otherId),
    ];
    for (const result of results) {
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(AccountError);
      expect(result._unsafeUnwrapErr().message).toBe("That account is not in this household.");
    }
    const intruder = account({
      id: "acct-intruder",
      householdId: otherId,
      openingBalanceCents: 999_900,
      movementCents: 0,
      transactionCount: 0,
    });
    expect(homeAccountTotalCents([maple, intruder], householdId)._unsafeUnwrap()).toBe(245_000 - 18_000);
    expect(homeAccountTotalCents([maple], otherId)._unsafeUnwrap()).toBe(0);
    expect(accountsForActiveLists([maple, intruder], householdId).map((row) => row.id)).toEqual(["acct-checking"]);
    expect(accountsForActiveLists([maple], otherId)).toEqual([]);
    expect(accountsForHistory([maple, intruder], otherId).map((row) => row.id)).toEqual(["acct-intruder"]);
    expect(accountAcceptsNewEntry(maple, otherId).isErr()).toBe(true);
  });
});
