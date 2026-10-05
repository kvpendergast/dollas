import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readTransactionDraft } from "./draft";

function form(entries: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    if (Array.isArray(value)) {
      for (const item of value) data.append(key, item);
    } else {
      data.set(key, value);
    }
  }
  return data;
}

const past = {
  payee: "Corner Market",
  occurredOn: "2024-03-02",
  accountId: "account-1",
  direction: "expense",
  amount: "40.00",
};

describe("readTransactionDraft", () => {
  it("keeps a single category on the whole amount", () => {
    const result = readTransactionDraft(
      form({
        ...past,
        amount: "12.50",
        categoryId: "groceries",
      }),
    );
    assert.ok(!("error" in result));
    assert.equal(result.draft.amountCents, -1_250);
    assert.deepEqual(result.draft.splits, [{ categoryId: "groceries", amountCents: -1_250 }]);
  });

  it("accepts a past transaction recategorized into a balanced split", () => {
    const result = readTransactionDraft(
      form({
        ...past,
        categoryId: ["groceries", "household"],
        splitAmount: ["25.00", "15.00"],
      }),
    );
    assert.ok(!("error" in result));
    assert.equal(result.draft.occurredOn, "2024-03-02");
    assert.equal(result.draft.amountCents, -4_000);
    assert.deepEqual(result.draft.splits, [
      { categoryId: "groceries", amountCents: -2_500 },
      { categoryId: "household", amountCents: -1_500 },
    ]);
  });

  it("records income as positive cents", () => {
    const result = readTransactionDraft(
      form({
        payee: "Northwind Payroll",
        occurredOn: "2023-11-15",
        accountId: "checking",
        direction: "income",
        amount: "3200",
        categoryId: "paycheck",
      }),
    );
    assert.ok(!("error" in result));
    assert.equal(result.draft.amountCents, 320_000);
    assert.equal(result.draft.splits[0]?.amountCents, 320_000);
  });

  it("accepts three categories when they add up", () => {
    const result = readTransactionDraft(
      form({
        ...past,
        amount: "10.00",
        categoryId: ["groceries", "household", "dining"],
        splitAmount: ["2.00", "3.50", "4.50"],
      }),
    );
    assert.ok(!("error" in result));
    assert.deepEqual(
      result.draft.splits.map((split) => split.amountCents),
      [-200, -350, -450],
    );
  });

  it("refuses an unbalanced split before a correction is saved", () => {
    const result = readTransactionDraft(
      form({
        ...past,
        amount: "50.00",
        categoryId: ["groceries", "household"],
        splitAmount: ["30.00", "10.00"],
      }),
    );
    assert.deepEqual(result, { error: "Category splits must add up to the transaction amount." });
  });

  it("refuses a split that fights the transaction direction", () => {
    const result = readTransactionDraft(
      form({
        ...past,
        amount: "10.00",
        categoryId: ["groceries", "household"],
        splitAmount: ["-4.00", "-6.00"],
      }),
    );
    assert.deepEqual(result, { error: "Splits must match the transaction direction." });
  });

  it("refuses a category used twice", () => {
    const result = readTransactionDraft(
      form({
        ...past,
        categoryId: ["groceries", "groceries"],
        splitAmount: ["20.00", "20.00"],
      }),
    );
    assert.deepEqual(result, { error: "A category can only appear once on a transaction." });
  });

  it("refuses a missing payee and a bad date", () => {
    assert.deepEqual(
      readTransactionDraft(form({ ...past, payee: "  ", categoryId: "groceries" })),
      { error: "Enter a payee." },
    );
    assert.deepEqual(
      readTransactionDraft(form({ ...past, occurredOn: "March 2", categoryId: "groceries" })),
      { error: "Choose a date." },
    );
  });
});
