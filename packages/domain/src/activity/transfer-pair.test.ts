import { describe, expect, it } from "vitest";
import {
  decideTransferLink,
  linkedDepositUndoWarning,
  rankTransferCandidates,
  type TransferDepositFacts,
  type TransferLineFacts,
} from "./transfer-pair";

const H = "household-1";
const line: TransferLineFacts = {
  id: "line",
  householdId: H,
  accountId: "payroll",
  occurredOn: "2026-03-13",
  amountCents: -312_045,
  incomeLine: true,
  transferOnly: true,
  linkedDepositId: null,
};
const deposit: TransferDepositFacts = {
  id: "deposit",
  householdId: H,
  accountId: "checking",
  occurredOn: "2026-03-13",
  amountCents: 312_045,
  deleted: false,
  splitRow: false,
  linkedLineId: null,
};

function message(lineFacts: TransferLineFacts | null, depositFacts: TransferDepositFacts | null) {
  const result = decideTransferLink(lineFacts, depositFacts, H);
  return result.isErr() ? result.error.message : result.value;
}

describe("decideTransferLink", () => {
  it("links a net-pay line to a mirrored deposit in another account", () => {
    expect(message(line, deposit)).toBe("linked");
  });

  it("is idempotent for the same pair", () => {
    expect(message({ ...line, linkedDepositId: "deposit" }, { ...deposit, linkedLineId: "line" })).toBe("exists");
  });

  it("keeps households apart", () => {
    expect(message({ ...line, householdId: "other" }, deposit)).toMatch(/not in this household/);
    expect(message(line, { ...deposit, householdId: "other" })).toMatch(/not in this household/);
    expect(message(null, deposit)).toMatch(/not in this household/);
  });

  it("refuses lines that are not paycheck transfer lines", () => {
    expect(message({ ...line, incomeLine: false }, deposit)).toMatch(/paycheck split/);
    expect(message({ ...line, transferOnly: false }, deposit)).toMatch(/transfer line/);
  });

  it("allows one link per row", () => {
    expect(message({ ...line, linkedDepositId: "elsewhere" }, deposit)).toMatch(/already linked to a deposit/);
    expect(message(line, { ...deposit, linkedLineId: "other-line" })).toMatch(/another paycheck/);
  });

  it("refuses deleted, split and same-account deposits", () => {
    expect(message(line, { ...deposit, deleted: true })).toMatch(/deleted/);
    expect(message(line, { ...deposit, splitRow: true })).toMatch(/part of a split/);
    expect(message(line, { ...deposit, accountId: "payroll" })).toMatch(/another account/);
  });

  it("reports the difference when the amounts do not mirror", () => {
    const result = decideTransferLink(line, { ...deposit, amountCents: 312_000 }, H);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe("The deposit is $3,120.00 and the line is $3,120.45. Link a deposit for the same amount.");
      expect(result.error.differenceCents).toBe(45);
    }
  });
});

describe("rankTransferCandidates", () => {
  const rows = [
    { id: "far", accountId: "checking", occurredOn: "2026-03-17", amountCents: 312_045 },
    { id: "late", accountId: "checking", occurredOn: "2026-03-15", amountCents: 312_045 },
    { id: "same-day-savings", accountId: "savings", occurredOn: "2026-03-13", amountCents: 312_045 },
    { id: "same-day-checking", accountId: "checking", occurredOn: "2026-03-13", amountCents: 312_045 },
    { id: "wrong-amount", accountId: "checking", occurredOn: "2026-03-13", amountCents: 312_000 },
    { id: "same-account", accountId: "payroll", occurredOn: "2026-03-13", amountCents: 312_045 },
    { id: "early", accountId: "checking", occurredOn: "2026-03-11", amountCents: 312_045 },
  ];

  it("suggests the same amount in another account inside the window, nearest first", () => {
    const ranked = rankTransferCandidates({ ...line, preferredAccountId: "checking" }, rows);
    expect(ranked.map((row) => row.id)).toEqual(["same-day-checking", "same-day-savings", "early", "late"]);
  });

  it("caps the list", () => {
    expect(rankTransferCandidates(line, rows, 1)).toHaveLength(1);
  });

  it("never suggests a withdrawal", () => {
    expect(rankTransferCandidates({ ...line, amountCents: 500 }, [{ id: "x", accountId: "checking", occurredOn: "2026-03-13", amountCents: -500 }])).toEqual([]);
  });
});

describe("linkedDepositUndoWarning", () => {
  it("is empty with no links and names them otherwise", () => {
    expect(linkedDepositUndoWarning(0)).toBe("");
    expect(linkedDepositUndoWarning(1)).toMatch(/^1 deposit from this import is linked/);
    expect(linkedDepositUndoWarning(21)).toMatch(/^21 deposits from this import are linked/);
  });
});
