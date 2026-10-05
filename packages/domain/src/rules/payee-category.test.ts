import { describe, expect, it } from "vitest";
import { PayeeCategoryRuleError } from "../errors";
import { importCsv, resolveCsvRows } from "../import/csv";
import { definePayeeCategoryRule, matchingPayeeRule, payeeRuleKey } from "./payee-category";

const accounts = [{ id: "acct-checking", name: "Checking" }];
const categories = [
  { id: "cat-groceries", name: "Groceries" },
  { id: "cat-dining", name: "Dining out" },
  { id: "cat-utilities", name: "Utilities" },
];

const marketRule = () =>
  definePayeeCategoryRule({ pattern: "market", categoryId: "cat-groceries" })._unsafeUnwrap();

describe("definePayeeCategoryRule", () => {
  it("trims the payee text and the category", () => {
    expect(
      definePayeeCategoryRule({ pattern: "  Market  ", categoryId: " cat-groceries " })._unsafeUnwrap(),
    ).toEqual({
      pattern: "Market",
      categoryId: "cat-groceries",
    });
  });

  it("rejects a payee match that is too short", () => {
    const result = definePayeeCategoryRule({ pattern: " M ", categoryId: "cat-groceries" });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(PayeeCategoryRuleError);
    expect(result._unsafeUnwrapErr().message).toBe("Enter the payee text to match.");
  });

  it("rejects a missing category", () => {
    const result = definePayeeCategoryRule({ pattern: "Market", categoryId: "  " });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toBe("Choose a category.");
  });

  it("treats case and surrounding spaces as the same payee text", () => {
    expect(payeeRuleKey("  Market ")).toBe(payeeRuleKey("market"));
  });
});

describe("matchingPayeeRule", () => {
  const groceries = definePayeeCategoryRule({ pattern: "Market", categoryId: "cat-groceries" })._unsafeUnwrap();
  const downtown = definePayeeCategoryRule({
    pattern: "Market, Downtown",
    categoryId: "cat-dining",
  })._unsafeUnwrap();

  it("matches when the payee contains the text, ignoring case", () => {
    expect(matchingPayeeRule("CORNER MARKET #12", [groceries])?.categoryId).toBe("cat-groceries");
    expect(matchingPayeeRule("City utilities", [groceries])).toBeNull();
  });

  it("prefers the longer payee match and does not change the rule list", () => {
    const rules = [groceries, downtown];
    expect(matchingPayeeRule("Market, Downtown", rules)?.categoryId).toBe("cat-dining");
    expect(rules).toEqual([groceries, downtown]);
  });
});

describe("payee rules on import", () => {
  const csv = [
    "date,payee,amount,account,category",
    "2026-03-02,Corner Market,-86.40,Checking,Dining out",
    "2026-03-03,City utilities,-40.00,Checking,Utilities",
  ].join("\n");

  function categorize(rules: ReturnType<typeof marketRule>[]) {
    return (rows: Parameters<typeof resolveCsvRows>[0]) => resolveCsvRows(rows, accounts, categories, rules);
  }

  it("sets the category from a matching rule and keeps the file category otherwise", async () => {
    const rule = marketRule();
    const outcome = await importCsv(csv, { rows: [] }, categorize([rule]));
    if (outcome.isErr()) throw outcome.error;
    expect(outcome.value.added).toBe(2);
    expect(outcome.value.addedRows.map((row) => [row.payee, row.categoryId, row.amountCents])).toEqual([
      ["Corner Market", "cat-groceries", -8_640],
      ["City utilities", "cat-utilities", -4_000],
    ]);
    expect(outcome.value.addedRows.every((row) => Number.isInteger(row.amountCents))).toBe(true);
  });

  it("leaves the rule in place when one imported transaction is categorized by hand", async () => {
    const rule = marketRule();
    const rules = [rule];
    const first = await importCsv(csv, { rows: [] }, categorize(rules));
    if (first.isErr()) throw first.error;
    const market = first.value.addedRows[0];
    const utilities = first.value.addedRows[1];
    if (!market || !utilities) throw new Error("expected two imported rows");

    const corrected = { ...market, categoryId: "cat-dining" };
    expect(corrected.categoryId).toBe("cat-dining");
    expect(rules).toEqual([rule]);

    const replay = await importCsv(csv, { rows: [corrected, utilities] }, categorize(rules));
    if (replay.isErr()) throw replay.error;
    expect(replay.value.added).toBe(0);

    const later = ["date,payee,amount,account,category", "2026-04-02,Corner Market,-12.00,Checking,"].join("\n");
    const next = await importCsv(later, { rows: [corrected, utilities] }, categorize(rules));
    if (next.isErr()) throw next.error;
    expect(next.value.addedRows).toHaveLength(1);
    expect(next.value.addedRows[0]?.categoryId).toBe("cat-groceries");
    expect(next.value.addedRows[0]?.amountCents).toBe(-1_200);
    expect(corrected.categoryId).toBe("cat-dining");
    expect(rules).toEqual([rule]);
  });

  it("still requires a category when no payee rule matches", async () => {
    const blank = ["date,payee,amount,account,category", "2026-03-03,City utilities,-40.00,Checking,"].join("\n");
    const outcome = await importCsv(blank, { rows: [] }, categorize([marketRule()]));
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) expect(outcome.error.message).toContain("Enter a category");
  });

  it("refuses a rule whose category is outside the household", async () => {
    const foreign = definePayeeCategoryRule({ pattern: "Market", categoryId: "cat-other" })._unsafeUnwrap();
    const outcome = await importCsv(csv, { rows: [] }, categorize([foreign]));
    expect(outcome.isErr()).toBe(true);
    if (outcome.isErr()) expect(outcome.error.message).toContain("this household does not have");
  });
});
