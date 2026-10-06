import { ConfigError, PayeeCategoryRuleError } from "@dollas/domain";
import { describe, expect, it } from "vitest";
import {
  PAYEE_RULES_APPLY_TO,
  describePayeeRuleApplied,
  describePayeeRuleApply,
  describePayeeRuleRemoval,
} from "./payee-rule-copy";
import {
  PAYEE_RULE_NOT_IN_HOUSEHOLD,
  payeeRuleMemberMessage,
  planPayeeRuleApply,
  type PayeeRuleApplyCandidate,
} from "./payee-rule-plan";

const HOUSE = "house-a";
const OTHER = "house-b";
const GROCERIES = "cat-groceries";
const DINING = "cat-dining";

function row(overrides: Partial<PayeeRuleApplyCandidate> & Pick<PayeeRuleApplyCandidate, "id" | "payee">): PayeeRuleApplyCandidate {
  return {
    householdId: HOUSE,
    deletedAt: null,
    splits: [{ categoryId: DINING }],
    ...overrides,
  };
}

const rule = { householdId: HOUSE, pattern: "Market", categoryId: GROCERIES };

describe("payee rule scope", () => {
  it("says rules apply to new imports and syncs, not to transactions already in the books", () => {
    expect(PAYEE_RULES_APPLY_TO).toBe(
      "Rules apply to new CSV imports and bank syncs. They do not change transactions already in the books.",
    );
    expect(PAYEE_RULES_APPLY_TO).not.toMatch(/DATABASE_|BANK_|SIMPLEFIN|Resend/i);
  });
});

describe("planPayeeRuleApply", () => {
  const willChange = row({ id: "change", payee: "Corner Market" });
  const otherCase = row({ id: "case", payee: "FARMERS MARKET" });
  const already = row({ id: "already", payee: "Corner Market", splits: [{ categoryId: GROCERIES }] });
  const deleted = row({ id: "deleted", payee: "Corner Market", deletedAt: "2026-04-01T00:00:00.000Z" });
  const split = row({
    id: "split",
    payee: "Corner Market",
    splits: [{ categoryId: DINING }, { categoryId: "cat-household" }],
  });
  const unlined = row({ id: "empty", payee: "Corner Market", splits: [] });
  const utilities = row({ id: "utilities", payee: "City utilities" });
  const otherHouse = row({ id: "other", payee: "Corner Market", householdId: OTHER });

  const transactions = [willChange, otherCase, already, deleted, split, unlined, utilities, otherHouse];

  it("counts matches that would change and skips deleted, split, and other households", () => {
    const plan = planPayeeRuleApply(rule, transactions);
    expect(plan.changeIds).toEqual(["change", "case"]);
    expect(plan.skippedSplitIds).toEqual(["split"]);
    expect(plan.skippedWithoutCategoryIds).toEqual(["empty"]);
    expect(plan.changeIds).not.toContain("deleted");
    expect(plan.changeIds).not.toContain("already");
    expect(plan.changeIds).not.toContain("other");
    expect(plan.skippedSplitIds).not.toContain("deleted");
    expect(plan.skippedSplitIds).not.toContain("other");
    expect(transactions.map((item) => item.id)).toEqual([
      "change",
      "case",
      "already",
      "deleted",
      "split",
      "empty",
      "utilities",
      "other",
    ]);
  });

  it("leaves a soft-deleted split out of both counts", () => {
    const plan = planPayeeRuleApply(rule, [
      row({
        id: "deleted-split",
        payee: "Corner Market",
        deletedAt: new Date("2026-04-02T00:00:00.000Z"),
        splits: [{ categoryId: DINING }, { categoryId: GROCERIES }],
      }),
    ]);
    expect(plan).toEqual({ changeIds: [], skippedSplitIds: [], skippedWithoutCategoryIds: [] });
  });
});

describe("payee rule confirmation copy", () => {
  it("names the rule being removed", () => {
    const copy = describePayeeRuleRemoval({ pattern: "Market", categoryName: "Groceries" });
    expect(copy.title).toBe('Remove the "Market" rule?');
    expect(copy.body).toContain("Market");
    expect(copy.body).toContain("Groceries");
    expect(copy.body).toContain("CSV imports and bank syncs");
  });

  it("states how many transactions would change and how many splits were skipped", () => {
    const copy = describePayeeRuleApply({
      pattern: "Market",
      categoryName: "Groceries",
      changeCount: 2,
      skippedSplitCount: 1,
      skippedWithoutCategoryCount: 0,
    });
    expect(copy.title).toContain("Market");
    expect(copy.body).toBe(
      '2 transactions matching "Market" will move to Groceries. 1 split transaction will be skipped.',
    );
    expect(
      describePayeeRuleApplied({
        pattern: "Market",
        categoryName: "Groceries",
        changeCount: 2,
        skippedSplitCount: 1,
        skippedWithoutCategoryCount: 1,
      }),
    ).toBe(
      "Moved 2 transactions to Groceries. 1 split transaction skipped. 1 transaction with no category line skipped.",
    );
  });
});

describe("payee rule member messages", () => {
  it("hides setup details and keeps a known household message", () => {
    const fallback = "Could not apply that payee rule.";
    const config = payeeRuleMemberMessage(new ConfigError("BANK_CONNECTION_KEYS is required."), fallback);
    expect(config).toBe(fallback);
    expect(config).not.toMatch(/BANK_|DATABASE_|SIMPLEFIN/i);

    const leaked = payeeRuleMemberMessage(new Error("DATABASE_URL is required"), fallback);
    expect(leaked).toBe(fallback);
    expect(leaked).not.toContain("DATABASE_URL");

    expect(payeeRuleMemberMessage(new Error(PAYEE_RULE_NOT_IN_HOUSEHOLD), fallback)).toBe(PAYEE_RULE_NOT_IN_HOUSEHOLD);
    expect(payeeRuleMemberMessage(new PayeeCategoryRuleError("Enter the payee text to match."), fallback)).toBe(
      "Enter the payee text to match.",
    );
  });
});
