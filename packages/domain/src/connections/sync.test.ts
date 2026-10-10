import { describe, expect, it } from "vitest";
import { ProviderSyncError } from "../errors";
import { providerTransactionFingerprint } from "./provider";
import type { ProviderAccount, ProviderTransaction } from "./provider";
import { bankBookRow, bookRow, legacyBookRow } from "./book-fixtures";
import { defaultTransactionsSince, planBankSync, planPlaidSync, type SyncLedgerAccount } from "./sync";

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
      books: [],
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
    expect(plan.value.transactions[0]?.providerTransactionId).toBe("txn-rent");
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
      books: [],
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
      books: [legacyBookRow(householdId, fingerprint("txn-rent"), "2026-04-02T00:00:00.000Z")],
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
      books: [
        legacyBookRow(householdId, fingerprint("txn-rent")),
        bankBookRow(householdId, { providerId: "simplefin", providerAccountId: "act-checking", providerTransactionId: "txn-new" }),
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
      books: [],
      rules: [],
    });
    if (plan.isErr()) throw plan.error;
    expect(plan.value.transactions).toEqual([]);
    if (plan.value.accounts[0]?.kind !== "create") throw new Error("create");
    expect(plan.value.accounts[0].openingBalanceCents).toBe(10_000);
  });
});

const linked = [{ providerAccountId: "act-checking", ledgerAccountId: "ledger-checking" }];
const coffee: ProviderTransaction = {
  providerTransactionId: "txn-coffee",
  providerAccountId: "act-checking",
  occurredOn: "2026-03-05",
  payee: "SQ *BLUE BOTTLE 1234",
  amountCents: -650,
  pending: false,
};
const simplefin = (id: string) => ({ providerId: "simplefin", providerAccountId: "act-checking", providerTransactionId: id });
const plaid = (id: string) => ({ providerId: "plaid", providerAccountId: "act-checking", providerTransactionId: id });

describe("idempotent sync and cross-source matching (PEN-203)", () => {
  it("re-running the same snapshot is a no-op once the identities are in the books", () => {
    const first = planBankSync({
      providerId: "simplefin",
      householdId,
      accounts: [checking],
      transactions: [rent, coffee],
      ledgerAccounts: [],
      links: linked,
      books: [],
      rules: [],
      fallbacks: { incomeCategoryId: "cat-income", expenseCategoryId: "cat-expense" },
    });
    if (first.isErr()) throw first.error;
    expect(first.value.transactions.map((row) => row.providerTransactionId)).toEqual(["txn-rent", "txn-coffee"]);
    const again = planBankSync({
      providerId: "simplefin",
      householdId,
      accounts: [checking],
      transactions: [rent, coffee, rent],
      ledgerAccounts: [],
      links: linked,
      books: first.value.transactions.map((row) => bankBookRow(householdId, simplefin(row.providerTransactionId))),
      rules: [],
    });
    if (again.isErr()) throw again.error;
    expect(again.value).toMatchObject({ transactions: [], links: [], updates: [] });
  });

  it("scopes identity to the provider account, so the same SimpleFIN id on two accounts is two charges", () => {
    const savings: ProviderAccount = { ...checking, providerAccountId: "act-savings", name: "Savings" };
    const plan = planBankSync({
      providerId: "simplefin",
      householdId,
      accounts: [checking, savings],
      transactions: [rent, { ...rent, providerAccountId: "act-savings" }],
      ledgerAccounts: [],
      links: [...linked, { providerAccountId: "act-savings", ledgerAccountId: "ledger-savings" }],
      books: [bankBookRow(householdId, simplefin("txn-rent"))],
      rules: [],
      fallbacks: { incomeCategoryId: "cat-income", expenseCategoryId: "cat-expense" },
    });
    if (plan.isErr()) throw plan.error;
    expect(plan.value.transactions.map((row) => row.providerAccountId)).toEqual(["act-savings"]);
  });

  it("links a bank charge to the CSV row with the same account and amount within three days", () => {
    const plan = planBankSync({
      providerId: "simplefin",
      householdId,
      accounts: [checking],
      transactions: [coffee],
      ledgerAccounts: [],
      links: linked,
      books: [
        bookRow(householdId, "csv-coffee", { occurredOn: "2026-03-03", payee: "Blue Bottle", amountCents: -650, importFingerprint: "abc:0" }),
        bookRow(householdId, "too-far", { occurredOn: "2026-03-09", amountCents: -650 }),
        bookRow(householdId, "other-amount", { occurredOn: "2026-03-05", amountCents: -651 }),
        bookRow(householdId, "other-account", { occurredOn: "2026-03-05", amountCents: -650, accountId: "ledger-savings" }),
        bookRow(householdId, "other-house", { householdId: "house-b", occurredOn: "2026-03-05", amountCents: -650 }),
      ],
      rules: [],
    });
    if (plan.isErr()) throw plan.error;
    expect(plan.value.transactions).toEqual([]);
    expect(plan.value.links).toEqual([
      {
        transactionId: "csv-coffee",
        providerAccountId: "act-checking",
        providerTransactionId: "txn-coffee",
        bankOccurredOn: "2026-03-05",
        bankPayee: "SQ *BLUE BOTTLE 1234",
        deleted: false,
      },
    ]);
  });

  it("uses the authorized date too, so a CSV dated at authorization still matches a late posting", () => {
    const books = [bookRow(householdId, "csv-coffee", { occurredOn: "2026-02-27", amountCents: -650 })];
    const base = { providerId: "plaid", householdId, accounts: [checking], ledgerAccounts: [], links: linked, books, rules: [] };
    const posted = planBankSync({ ...base, transactions: [coffee], fallbacks: { incomeCategoryId: "i", expenseCategoryId: "e" } });
    if (posted.isErr()) throw posted.error;
    expect(posted.value.links).toEqual([]);
    const authorized = planBankSync({ ...base, transactions: [{ ...coffee, authorizedOn: "2026-02-28" }] });
    if (authorized.isErr()) throw authorized.error;
    expect(authorized.value.links.map((link) => link.transactionId)).toEqual(["csv-coffee"]);
  });

  it("ambiguity: closest date wins, then payee similarity, and each row pairs once", () => {
    const books = [
      bookRow(householdId, "a-two-days", { occurredOn: "2026-03-03", payee: "Blue Bottle", amountCents: -650 }),
      bookRow(householdId, "b-same-day-hardware", { occurredOn: "2026-03-05", payee: "Hardware", amountCents: -650 }),
      bookRow(householdId, "c-same-day-coffee", { occurredOn: "2026-03-05", payee: "Blue Bottle Coffee", amountCents: -650 }),
    ];
    const plan = planBankSync({
      providerId: "simplefin",
      householdId,
      accounts: [checking],
      transactions: [coffee, { ...coffee, providerTransactionId: "txn-coffee-2", occurredOn: "2026-03-04" }],
      ledgerAccounts: [],
      links: linked,
      books,
      rules: [],
    });
    if (plan.isErr()) throw plan.error;
    // txn-coffee is 0 days from b and c; c shares more payee words, so c.
    // txn-coffee-2 (03-04) is 1 day from a and b (c is taken); a's payee is closer, so a.
    expect(plan.value.links.map((link) => [link.providerTransactionId, link.transactionId])).toEqual([
      ["txn-coffee", "c-same-day-coffee"],
      ["txn-coffee-2", "a-two-days"],
    ]);
    // The same inputs in another order give the same pairs.
    const reversed = planBankSync({
      providerId: "simplefin",
      householdId,
      accounts: [checking],
      transactions: [{ ...coffee, providerTransactionId: "txn-coffee-2", occurredOn: "2026-03-04" }, coffee],
      ledgerAccounts: [],
      links: linked,
      books: [...books].reverse(),
      rules: [],
    });
    if (reversed.isErr()) throw reversed.error;
    expect(new Set(reversed.value.links.map((link) => `${link.providerTransactionId}>${link.transactionId}`))).toEqual(
      new Set(["txn-coffee>c-same-day-coffee", "txn-coffee-2>a-two-days"]),
    );
  });

  it("links a soft-deleted match and keeps it deleted instead of inserting a new row", () => {
    const plan = planBankSync({
      providerId: "simplefin",
      householdId,
      accounts: [checking],
      transactions: [coffee],
      ledgerAccounts: [],
      links: linked,
      books: [bookRow(householdId, "deleted-coffee", { occurredOn: "2026-03-05", amountCents: -650, deletedAt: "2026-03-06T00:00:00.000Z" })],
      rules: [],
    });
    if (plan.isErr()) throw plan.error;
    expect(plan.value.transactions).toEqual([]);
    expect(plan.value.links).toMatchObject([{ transactionId: "deleted-coffee", deleted: true }]);
  });

  it("never matches rows the bank already backs, and never matches on a brand-new ledger account", () => {
    const plan = planBankSync({
      providerId: "simplefin",
      householdId,
      accounts: [checking],
      transactions: [coffee],
      ledgerAccounts: [],
      links: linked,
      books: [
        bankBookRow(householdId, plaid("other"), { occurredOn: "2026-03-05", amountCents: -650 }),
        legacyBookRow(householdId, "bank:plaid:older"),
      ],
      rules: [],
      fallbacks: { incomeCategoryId: "cat-income", expenseCategoryId: "cat-expense" },
    });
    if (plan.isErr()) throw plan.error;
    expect(plan.value.links).toEqual([]);
    expect(plan.value.transactions).toHaveLength(1);
  });

  it("pending to posted: the posted row takes over a known pending row instead of adding one", () => {
    const plan = planPlaidSync({
      householdId,
      accounts: [checking],
      added: [{ ...coffee, providerTransactionId: "posted-1", pendingTransactionId: "pending-1", occurredOn: "2026-03-06" }],
      modified: [],
      removed: ["pending-1"],
      ledgerAccounts: [],
      links: linked,
      books: [bankBookRow(householdId, plaid("pending-1"), { amountCents: -600, payee: "Blue Bottle (pending)" })],
      rules: [],
    });
    if (plan.isErr()) throw plan.error;
    expect(plan.value.added).toEqual([]);
    expect(plan.value.removed).toEqual([]);
    expect(plan.value.updated).toEqual([
      {
        transactionId: "row-pending-1",
        providerAccountId: "act-checking",
        providerTransactionId: "posted-1",
        occurredOn: "2026-03-06",
        payee: "SQ *BLUE BOTTLE 1234",
        amountCents: -650,
        matched: false,
        deleted: false,
        clearLegacyFingerprint: false,
      },
    ]);
  });

  it("pending rows are never booked, so pending then posted (Plaid's usual shape) is one transaction", () => {
    const pending = planPlaidSync({
      householdId,
      accounts: [checking],
      added: [{ ...coffee, providerTransactionId: "pending-1", pending: true }],
      modified: [],
      removed: [],
      ledgerAccounts: [],
      links: linked,
      books: [],
      rules: [],
    });
    if (pending.isErr()) throw pending.error;
    expect(pending.value.added).toEqual([]);
    const posted = planPlaidSync({
      householdId,
      accounts: [checking],
      added: [{ ...coffee, providerTransactionId: "posted-1", pendingTransactionId: "pending-1" }],
      modified: [],
      removed: ["pending-1"],
      ledgerAccounts: [],
      links: linked,
      books: [],
      rules: [],
      fallbacks: { incomeCategoryId: "cat-income", expenseCategoryId: "cat-expense" },
    });
    if (posted.isErr()) throw posted.error;
    expect(posted.value.added.map((row) => row.providerTransactionId)).toEqual(["posted-1"]);
    expect(posted.value.removed).toEqual([]);
  });

  it("Plaid removed: hides a row sync created, unlinks (and keeps) a matched row, ignores deleted ones", () => {
    const plan = planPlaidSync({
      householdId,
      accounts: [checking],
      added: [],
      modified: [],
      removed: ["bank-only", "matched", "gone", "unknown"],
      ledgerAccounts: [],
      links: linked,
      books: [
        bankBookRow(householdId, plaid("bank-only")),
        bankBookRow(householdId, plaid("matched"), { matched: true, importFingerprint: "abc:1" }),
        bankBookRow(householdId, plaid("gone"), { deletedAt: "2026-03-08T00:00:00.000Z" }),
      ],
      rules: [],
    });
    if (plan.isErr()) throw plan.error;
    expect(plan.value.removed).toEqual([
      { transactionId: "row-bank-only", matched: false },
      { transactionId: "row-matched", matched: true },
    ]);
  });

  it("Plaid modified on a matched row is planned as matched, so the member's payee and date stay", () => {
    const plan = planPlaidSync({
      householdId,
      accounts: [checking],
      added: [],
      modified: [{ ...coffee, providerTransactionId: "matched", amountCents: -700 }],
      removed: [],
      ledgerAccounts: [],
      links: linked,
      books: [bankBookRow(householdId, plaid("matched"), { matched: true, amountCents: -650 })],
      rules: [],
    });
    if (plan.isErr()) throw plan.error;
    expect(plan.value.updated).toMatchObject([{ transactionId: "row-matched", matched: true, amountCents: -700 }]);
  });
});

describe("defaultTransactionsSince", () => {
  it("is a civil date ninety days earlier", () => {
    expect(defaultTransactionsSince(new Date("2026-04-06T15:00:00.000Z"))).toBe("2026-01-06");
  });
});
