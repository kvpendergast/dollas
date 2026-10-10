import { describe, expect, it } from "vitest";
import { amendTransactionEntry, defineTransactionEntry } from "./entry";

const base = {
  payee: "Corner Grocer",
  occurredOn: "2026-10-01",
  accountId: "acct",
  amountCents: -4200,
  splits: [{ categoryId: "groceries", amountCents: -4200 }],
};

describe("defineTransactionEntry", () => {
  it("accepts a balanced entry and trims the payee", () => {
    const entry = defineTransactionEntry({ ...base, payee: "  Corner Grocer " });
    expect(entry._unsafeUnwrap().payee).toBe("Corner Grocer");
  });

  it("refuses missing payee, bad date, zero amount, and unbalanced splits", () => {
    expect(defineTransactionEntry({ ...base, payee: " " })._unsafeUnwrapErr().message).toBe("Enter a payee.");
    expect(defineTransactionEntry({ ...base, occurredOn: "2026-02-30" })._unsafeUnwrapErr().message).toBe("Choose a date.");
    expect(defineTransactionEntry({ ...base, amountCents: 0 }).isErr()).toBe(true);
    expect(defineTransactionEntry({ ...base, amountCents: 1.5 }).isErr()).toBe(true);
    const off = defineTransactionEntry({
      ...base,
      splits: [
        { categoryId: "a", amountCents: -2000 },
        { categoryId: "b", amountCents: -1000 },
      ],
    });
    expect(off.isErr()).toBe(true);
  });
});

describe("amendTransactionEntry", () => {
  it("keeps unspecified fields and moves a single split with a new amount", () => {
    const amended = amendTransactionEntry(base, { amountCents: -5000 })._unsafeUnwrap();
    expect(amended.payee).toBe("Corner Grocer");
    expect(amended.splits).toEqual([{ categoryId: "groceries", amountCents: -5000 }]);
  });

  it("recategorizes by replacing the splits", () => {
    const amended = amendTransactionEntry(base, { splits: [{ categoryId: "dining", amountCents: -4200 }] })._unsafeUnwrap();
    expect(amended.splits[0]?.categoryId).toBe("dining");
  });

  it("puts a split transaction in one category with categoryId", () => {
    const split = {
      ...base,
      splits: [
        { categoryId: "a", amountCents: -2200 },
        { categoryId: "b", amountCents: -2000 },
      ],
    };
    expect(amendTransactionEntry(split, { categoryId: "c" })._unsafeUnwrap().splits).toEqual([{ categoryId: "c", amountCents: -4200 }]);
    expect(amendTransactionEntry(split, { categoryId: "c", splits: [] }).isErr()).toBe(true);
  });

  it("asks for splits again when a split transaction changes amount", () => {
    const split = {
      ...base,
      splits: [
        { categoryId: "a", amountCents: -2200 },
        { categoryId: "b", amountCents: -2000 },
      ],
    };
    expect(amendTransactionEntry(split, { amountCents: -5000 }).isErr()).toBe(true);
    expect(
      amendTransactionEntry(split, {
        amountCents: -5000,
        splits: [
          { categoryId: "a", amountCents: -3000 },
          { categoryId: "b", amountCents: -2000 },
        ],
      }).isOk(),
    ).toBe(true);
  });
});
