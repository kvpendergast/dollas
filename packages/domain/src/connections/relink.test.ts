import { describe, expect, it } from "vitest";
import { bankBookRow, bookRow } from "./book-fixtures";
import type { ProviderAccount, ProviderTransaction } from "./provider";
import { planBankSync, planPlaidSync, planReattachments, type SyncAccountLink, type SyncLedgerAccount } from "./sync";

/**
 * PEN-251: a reconnect gives the same account and charges new provider ids.
 * The planner reattaches the old link and re-keys the old rows instead of
 * adding a second account and a second copy of every charge.
 */
const householdId = "house-a";
const ledger: SyncLedgerAccount[] = [
  { id: "ledger-checking", householdId, name: "Joint checking", type: "checking", archivedAt: null },
  { id: "ledger-card", householdId, name: "Visa", type: "credit", archivedAt: null },
];
const fallbacks = { incomeCategoryId: "cat-income", expenseCategoryId: "cat-expense" };
const newChecking: ProviderAccount = { providerAccountId: "new-checking", name: "Plaid Checking", type: "checking", currency: "USD", balanceCents: 50_000, mask: "0000" };
const oldLink: SyncAccountLink = { providerAccountId: "old-checking", ledgerAccountId: "ledger-checking", active: false, providerName: "Plaid Checking", mask: "0000" };
const old = (id: string, extra = {}) => bankBookRow(householdId, { providerId: "plaid", providerAccountId: "old-checking", providerTransactionId: id }, extra);
const charge = (id: string, occurredOn: string, amountCents: number, payee = "Corner Market"): ProviderTransaction => ({
  providerTransactionId: id,
  providerAccountId: "new-checking",
  occurredOn,
  payee,
  amountCents,
  pending: false,
});

function plan(input: { links?: SyncAccountLink[]; books?: ReturnType<typeof old>[]; added: ProviderTransaction[]; accounts?: ProviderAccount[]; since?: string }) {
  const result = planPlaidSync({
    householdId,
    accounts: input.accounts ?? [newChecking],
    added: input.added,
    modified: [],
    removed: [],
    ledgerAccounts: ledger,
    links: input.links ?? [oldLink],
    books: input.books ?? [],
    rules: [],
    fallbacks,
    since: input.since ?? "2026-01-01",
  });
  if (result.isErr()) throw result.error;
  return result.value;
}

describe("reattaching an account after a reconnect", () => {
  it("reattaches a disconnected link with the same mask and type, even after a rename", () => {
    const value = plan({ added: [] });
    expect(value.accounts).toEqual([
      { kind: "reattach", providerAccountId: "new-checking", previousProviderAccountId: "old-checking", ledgerAccountId: "ledger-checking", currency: "USD", balanceCents: 50_000 },
    ]);
  });

  it("falls back to the name when a mask is unknown (stored provider name, else the ledger name)", () => {
    const noMask = { ...newChecking, mask: undefined };
    expect(planReattachments([noMask], [{ ...oldLink, mask: null }], ledger).get("new-checking")?.providerAccountId).toBe("old-checking");
    const legacy: SyncAccountLink = { providerAccountId: "old-checking", ledgerAccountId: "ledger-checking", active: false };
    expect(planReattachments([{ ...noMask, name: "Joint Checking" }], [legacy], ledger).size).toBe(1);
    expect(planReattachments([noMask], [legacy], ledger).size).toBe(0);
  });

  it("never reattaches an active link, a different mask or type, an archived account, or an ambiguous fit", () => {
    expect(planReattachments([newChecking], [{ ...oldLink, active: true }], ledger).size).toBe(0);
    expect(planReattachments([newChecking], [{ ...oldLink }], ledger).size).toBe(1);
    expect(planReattachments([newChecking], [{ ...oldLink, mask: "9999" }], ledger).size).toBe(0);
    expect(planReattachments([{ ...newChecking, type: "credit" }], [oldLink], ledger).size).toBe(0);
    expect(planReattachments([newChecking], [oldLink], [{ ...ledger[0], archivedAt: "2026-02-01" }]).size).toBe(0);
    const twin: SyncAccountLink = { ...oldLink, providerAccountId: "old-savings", ledgerAccountId: "ledger-twin" };
    const twinLedger = [...ledger, { ...ledger[0], id: "ledger-twin" }];
    expect(planReattachments([newChecking], [oldLink, twin], twinLedger).size).toBe(0);
    expect(planReattachments([newChecking, { ...newChecking, providerAccountId: "new-2" }], [oldLink], ledger).size).toBe(0);
  });
});

describe("re-keying the old rows", () => {
  it("re-keys each old row to its new id instead of inserting, keeping deleted rows deleted", () => {
    const books = [
      old("o-1", { id: "row-1", occurredOn: "2026-03-02", amountCents: -1_234, payee: "Groceries (renamed)" }),
      old("o-2", { id: "row-2", occurredOn: "2026-03-05", amountCents: -5_000, deletedAt: "2026-03-06T00:00:00.000Z" }),
    ];
    const value = plan({ books, added: [charge("n-1", "2026-03-03", -1_234), charge("n-2", "2026-03-05", -5_000), charge("n-3", "2026-03-09", -700)] });
    expect([...value.rekeys].sort((a, b) => a.transactionId.localeCompare(b.transactionId))).toEqual([
      { transactionId: "row-1", previous: { providerAccountId: "old-checking", providerTransactionId: "o-1" }, providerAccountId: "new-checking", providerTransactionId: "n-1", deleted: false },
      { transactionId: "row-2", previous: { providerAccountId: "old-checking", providerTransactionId: "o-2" }, providerAccountId: "new-checking", providerTransactionId: "n-2", deleted: true },
    ]);
    expect(value.added.map((row) => row.providerTransactionId)).toEqual(["n-3"]);
    expect(value.links).toEqual([]);
  });

  it("is a no-op once re-keyed (the new ids are known)", () => {
    const books = [bankBookRow(householdId, { providerId: "plaid", providerAccountId: "new-checking", providerTransactionId: "n-1" }, { amountCents: -1_234 })];
    const value = plan({ links: [{ providerAccountId: "new-checking", ledgerAccountId: "ledger-checking" }], books, added: [charge("n-1", "2026-03-02", -1_234)] });
    expect(value.accounts[0].kind).toBe("update");
    expect(value).toMatchObject({ added: [], links: [], rekeys: [], updated: [] });
  });

  it("does not re-key rows of an account an active connection still feeds", () => {
    // Plaid update mode or a second live item: the old id is still active, so its rows are its own.
    const books = [old("o-1", { amountCents: -1_234 })];
    const value = plan({
      links: [{ providerAccountId: "old-checking", ledgerAccountId: "ledger-checking", active: true }, { providerAccountId: "new-checking", ledgerAccountId: "ledger-checking" }],
      books,
      added: [charge("n-1", "2026-03-02", -1_234)],
    });
    expect(value.rekeys).toEqual([]);
  });

  it("prefers the bank's own old copy over a CSV row, so a separated pair stays separate", () => {
    // "Not the same charge" left the member row without an identity and the bank copy with the old one.
    const books = [
      bookRow(householdId, "member-row", { amountCents: -2_000, occurredOn: "2026-03-02", payee: "Corner Market" }),
      old("o-copy", { id: "bank-copy", amountCents: -2_000, occurredOn: "2026-03-02", payee: "Corner Market" }),
    ];
    const value = plan({ books, added: [charge("n-copy", "2026-03-02", -2_000)] });
    expect(value.rekeys.map((rekey) => rekey.transactionId)).toEqual(["bank-copy"]);
    expect(value.links).toEqual([]);
    expect(value.added).toEqual([]);
  });

  it("uses the bank's own date for a matched row the member moved, and the PEN-203 window", () => {
    const books = [old("o-1", { amountCents: -900, occurredOn: "2026-03-20", bankOccurredOn: "2026-03-02", matched: true })];
    expect(plan({ books, added: [charge("n-1", "2026-03-03", -900)] }).rekeys).toHaveLength(1);
    expect(plan({ books: [old("o-1", { amountCents: -900, occurredOn: "2026-03-10" })], added: [charge("n-1", "2026-03-03", -900)] }).rekeys).toEqual([]);
  });

  it("ignores stale rows from before the new connection's start date", () => {
    const books = [old("o-1", { amountCents: -900, occurredOn: "2025-12-20" })];
    expect(plan({ books, added: [charge("n-1", "2025-12-21", -900)], since: "2026-01-01" }).rekeys).toEqual([]);
    expect(plan({ books, added: [charge("n-1", "2025-12-30", -900)], since: "2026-01-01" }).rekeys).toEqual([]);
    expect(plan({ books: [old("o-1", { amountCents: -900, occurredOn: "2025-12-30" })], added: [charge("n-1", "2025-12-30", -900)], since: "2026-01-01" }).rekeys).toHaveLength(1);
  });

  it("works the same for SimpleFIN when its ids change", () => {
    const result = planBankSync({
      providerId: "simplefin",
      householdId,
      accounts: [{ ...newChecking, mask: undefined, name: "Joint checking" }],
      transactions: [charge("n-1", "2026-03-02", -1_234)],
      ledgerAccounts: ledger,
      links: [{ providerAccountId: "old-checking", ledgerAccountId: "ledger-checking", active: false }],
      books: [bankBookRow(householdId, { providerId: "simplefin", providerAccountId: "old-checking", providerTransactionId: "o-1" }, { amountCents: -1_234 })],
      rules: [],
      fallbacks,
    });
    if (result.isErr()) throw result.error;
    expect(result.value.accounts[0].kind).toBe("reattach");
    expect(result.value.rekeys.map((rekey) => rekey.providerTransactionId)).toEqual(["n-1"]);
    expect(result.value.transactions).toEqual([]);
  });
});
