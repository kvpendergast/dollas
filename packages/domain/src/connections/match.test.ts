import { describe, expect, it } from "vitest";
import { pairCharges, payeeSimilarity, planBankSeparation, shiftCivilDate, type MatchCandidate } from "./match";

const candidate = (id: string, extra: Partial<MatchCandidate> = {}): MatchCandidate => ({
  id,
  accountId: "acct",
  amountCents: -500,
  dates: ["2026-03-10"],
  payee: "Corner Store",
  deleted: false,
  order: id,
  ...extra,
});

describe("pairCharges", () => {
  it("requires the same account, the same cents, and dates within the window", () => {
    const incoming = [{ key: "k", accountId: "acct", amountCents: -500, dates: ["2026-03-13"], payee: "Corner Store" }];
    expect(pairCharges(incoming, [candidate("x", { dates: ["2026-03-09"] })])).toEqual([]);
    expect(pairCharges(incoming, [candidate("x", { amountCents: 500 })])).toEqual([]);
    expect(pairCharges(incoming, [candidate("x", { accountId: "other" })])).toEqual([]);
    expect(pairCharges(incoming, [candidate("x")])).toMatchObject([{ incomingKey: "k", candidateId: "x", days: 3 }]);
  });

  it("prefers a live row over a soft-deleted one when everything else ties, then the earlier order key", () => {
    const incoming = [{ key: "k", accountId: "acct", amountCents: -500, dates: ["2026-03-10"], payee: "Corner Store" }];
    expect(pairCharges(incoming, [candidate("a", { deleted: true }), candidate("b")])[0]?.candidateId).toBe("b");
    expect(pairCharges(incoming, [candidate("b"), candidate("a")])[0]?.candidateId).toBe("a");
  });

  it("pairs two identical same-day charges one to one, not both to the first", () => {
    const incoming = [
      { key: "k1", accountId: "acct", amountCents: -500, dates: ["2026-03-10"], payee: "Corner Store" },
      { key: "k2", accountId: "acct", amountCents: -500, dates: ["2026-03-10"], payee: "Corner Store" },
    ];
    const pairs = pairCharges(incoming, [candidate("a"), candidate("b"), candidate("c")]);
    expect(pairs.map((pair) => pair.candidateId).sort()).toEqual(["a", "b"]);
    expect(new Set(pairs.map((pair) => pair.incomingKey))).toEqual(new Set(["k1", "k2"]));
  });
});

describe("payeeSimilarity", () => {
  it("compares words, ignoring case, punctuation, and store numbers", () => {
    expect(payeeSimilarity("SQ *BLUE BOTTLE #1234", "Blue Bottle Coffee")).toBe(0.5);
    expect(payeeSimilarity("Rent", "rent")).toBe(1);
    expect(payeeSimilarity("Rent", "")).toBe(0);
  });
});

describe("shiftCivilDate", () => {
  it("moves across month ends", () => {
    expect(shiftCivilDate("2026-03-01", -3)).toBe("2026-02-26");
    expect(shiftCivilDate("2026-02-27", 3)).toBe("2026-03-02");
  });
});

describe("planBankSeparation", () => {
  const bank = { providerId: "plaid", providerAccountId: "acct", providerTransactionId: "txn" };
  const row = {
    id: "t1",
    householdId: "h",
    deletedAt: null,
    matchedAt: "2026-03-06T00:00:00.000Z",
    occurredOn: "2026-03-04",
    payee: "Groceries (renamed)",
    amountCents: -4_200,
    bankOccurredOn: "2026-03-05",
    bankPayee: "MARKET 042",
    bank,
  };
  it("rebuilds the bank's copy from its own date and payee", () => {
    const plan = planBankSeparation(row, "h");
    expect(plan._unsafeUnwrap().bankCopy).toEqual({ occurredOn: "2026-03-05", payee: "MARKET 042", amountCents: -4_200, bank });
  });
  it("refuses rows that were not matched, are deleted, or belong elsewhere", () => {
    expect(planBankSeparation({ ...row, matchedAt: null }, "h")._unsafeUnwrapErr().message).toContain("not matched");
    expect(planBankSeparation({ ...row, deletedAt: "2026-03-07T00:00:00.000Z" }, "h")._unsafeUnwrapErr().message).toContain("Restore");
    expect(planBankSeparation(row, "other")._unsafeUnwrapErr().message).toContain("not in this household");
    expect(planBankSeparation(null, "h").isErr()).toBe(true);
  });
});
