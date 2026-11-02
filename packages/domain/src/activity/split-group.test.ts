import { describe, expect, it } from "vitest";
import { SplitGroupError } from "../errors";
import { describeSplitDifference, divideByPercent, MAX_SPLIT_LINES, planSplit, splitCounts, splitKindFor } from "./split-group";

const paycheck = { amountCents: 500_000, accountId: "clearing", payee: "Rippling", categoryKinds: ["income"] as const };
const costco = { amountCents: -30_000, accountId: "card", payee: "Costco", categoryKinds: ["expense"] as const };

describe("splitKindFor", () => {
  it("is income for a positive, income-only parent", () => {
    expect(splitKindFor(paycheck)).toBe("income");
  });
  it("is allocation for charges, refunds outside income, and mixed parents", () => {
    expect(splitKindFor(costco)).toBe("allocation");
    expect(splitKindFor({ amountCents: 5_000, categoryKinds: ["transfer"] })).toBe("allocation");
    expect(splitKindFor({ amountCents: 5_000, categoryKinds: ["income", "expense"] })).toBe("allocation");
    expect(splitKindFor({ amountCents: -5_000, categoryKinds: ["income"] })).toBe("allocation");
  });
});

describe("planSplit, income", () => {
  it("signs paycheck lines negative and keeps deposits on transfer lines", () => {
    const plan = planSplit(paycheck, [
      { categoryId: "tax", categoryKind: "expense", amountCents: 100_000, payee: "Federal tax" },
      { categoryId: "401k", categoryKind: "transfer", amountCents: 50_000 },
      { categoryId: "net", categoryKind: "transfer", amountCents: 350_000, toAccountId: "checking" },
    ])._unsafeUnwrap();
    expect(plan.kind).toBe("income");
    expect(plan.lines.map((line) => line.amountCents)).toEqual([-100_000, -50_000, -350_000]);
    expect(plan.lines[0]?.payee).toBe("Federal tax");
    expect(plan.lines[1]?.payee).toBe("Rippling");
    expect(plan.lines[2]?.toAccountId).toBe("checking");
  });

  it("reports how much is left to assign", () => {
    const error = planSplit(paycheck, [{ categoryId: "tax", categoryKind: "expense", amountCents: 490_000 }])._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(SplitGroupError);
    expect(error.differenceCents).toBe(10_000);
    expect(error.message).toContain("$100.00 left to assign");
  });

  it("reports lines that are over", () => {
    const error = planSplit(paycheck, [{ categoryId: "tax", categoryKind: "expense", amountCents: 500_100 }])._unsafeUnwrapErr();
    expect(error.differenceCents).toBe(-100);
    expect(error.message).toContain("over");
  });

  it("refuses income lines, paid-back lines, and deposits outside transfers or to the same account", () => {
    expect(planSplit(paycheck, [{ categoryId: "salary", categoryKind: "income", amountCents: 500_000 }]).isErr()).toBe(true);
    expect(planSplit(paycheck, [{ categoryId: "tax", categoryKind: "expense", amountCents: 500_000, reimbursed: true }]).isErr()).toBe(true);
    expect(planSplit(paycheck, [{ categoryId: "tax", categoryKind: "expense", amountCents: 500_000, toAccountId: "checking" }]).isErr()).toBe(true);
    expect(planSplit(paycheck, [{ categoryId: "net", categoryKind: "transfer", amountCents: 500_000, toAccountId: "clearing" }]).isErr()).toBe(true);
  });

  it("divides net pay by percent of the rest, with the leftover cent on the last line", () => {
    const plan = planSplit({ ...paycheck, amountCents: 100_001 }, [
      { categoryId: "tax", categoryKind: "expense", amountCents: 20_000 },
      { categoryId: "net", categoryKind: "transfer", remainderPercent: 85, toAccountId: "joint" },
      { categoryId: "net", categoryKind: "transfer", remainderPercent: 15, toAccountId: "savings" },
    ])._unsafeUnwrap();
    expect(plan.lines.map((line) => line.amountCents)).toEqual([-20_000, -68_000, -12_001]);
  });

  it("refuses percents that do not reach 100 and fixed lines that use everything", () => {
    expect(planSplit(paycheck, [{ categoryId: "net", categoryKind: "transfer", remainderPercent: 90 }])._unsafeUnwrapErr().message).toContain("100");
    const none = planSplit(paycheck, [
      { categoryId: "tax", categoryKind: "expense", amountCents: 500_000 },
      { categoryId: "net", categoryKind: "transfer", remainderPercent: 100 },
    ])._unsafeUnwrapErr();
    expect(none.differenceCents).toBe(0);
  });
});

describe("planSplit, allocation", () => {
  it("keeps the parent's sign and allows paid-back lines on a charge", () => {
    const plan = planSplit(costco, [
      { categoryId: "groceries", categoryKind: "expense", amountCents: 20_000 },
      { categoryId: "household", categoryKind: "expense", amountCents: 10_000, reimbursed: true, payee: "Sam's half" },
    ])._unsafeUnwrap();
    expect(plan.kind).toBe("allocation");
    expect(plan.lines.map((line) => line.amountCents)).toEqual([-20_000, -10_000]);
    expect(plan.lines[1]?.reimbursed).toBe(true);
  });

  it("splits an inflow with positive lines and refuses paid-back inflow lines and deposits", () => {
    const venmo = { amountCents: 6_000, accountId: "venmo", payee: "Venmo", categoryKinds: ["transfer"] as const };
    expect(planSplit(venmo, [
      { categoryId: "a", categoryKind: "transfer", amountCents: 4_000 },
      { categoryId: "b", categoryKind: "income", amountCents: 2_000 },
    ])._unsafeUnwrap().lines.map((line) => line.amountCents)).toEqual([4_000, 2_000]);
    expect(planSplit(venmo, [{ categoryId: "a", categoryKind: "transfer", amountCents: 6_000, reimbursed: true }]).isErr()).toBe(true);
    expect(planSplit(costco, [{ categoryId: "a", categoryKind: "transfer", amountCents: 30_000, toAccountId: "x" }]).isErr()).toBe(true);
  });

  it("refuses empty, oversize, zero, and both-or-neither sizes", () => {
    expect(planSplit(costco, []).isErr()).toBe(true);
    const many = Array.from({ length: MAX_SPLIT_LINES + 1 }, () => ({ categoryId: "g", categoryKind: "expense" as const, amountCents: 1 }));
    expect(planSplit(costco, many)._unsafeUnwrapErr().message).toContain(String(MAX_SPLIT_LINES));
    expect(planSplit(costco, [{ categoryId: "g", categoryKind: "expense", amountCents: 0 }]).isErr()).toBe(true);
    expect(planSplit(costco, [{ categoryId: "g", categoryKind: "expense" }]).isErr()).toBe(true);
    expect(planSplit(costco, [{ categoryId: "g", categoryKind: "expense", amountCents: 30_000, remainderPercent: 100 }]).isErr()).toBe(true);
    expect(planSplit({ ...costco, amountCents: 0 }, [{ categoryId: "g", categoryKind: "expense", amountCents: 1 }]).isErr()).toBe(true);
  });
});

describe("helpers", () => {
  it("divides by percent", () => {
    expect(divideByPercent(100, [33.33, 33.33, 33.34])).toEqual([33, 33, 34]);
  });
  it("describes differences", () => {
    expect(describeSplitDifference(0)).toBe("The lines add up.");
    expect(describeSplitDifference(250)).toBe("$2.50 left to assign.");
    expect(describeSplitDifference(-250)).toBe("The lines are $2.50 over.");
  });
  it("says what counts where", () => {
    expect(splitCounts({ splitKind: "allocation", reimbursed: false })).toEqual({ balances: false, books: false });
    expect(splitCounts({ splitKind: "income", reimbursed: false })).toEqual({ balances: true, books: true });
    expect(splitCounts({ splitKind: null, reimbursed: true })).toEqual({ balances: true, books: false });
  });
});
