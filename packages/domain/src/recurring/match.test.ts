import { describe, expect, it } from "vitest";
import {
  amountMatchesItem,
  occurrenceForManualLink,
  payeeMatchesItem,
  planRecurringLinks,
  type RecurringMatchItem,
  type RecurringMatchTransaction,
} from "./match";

const H = "house-1";
const item = (extra: Partial<RecurringMatchItem> = {}): RecurringMatchItem => ({
  id: "item-rent",
  householdId: H,
  payeeMatch: "Maple Property",
  amountCents: -150000,
  accountId: null,
  tolerancePercent: 5,
  toleranceCents: 0,
  windowDays: 3,
  paused: false,
  cadence: "monthly",
  anchorDate: "2026-01-01",
  dayOfMonth: null,
  secondDayOfMonth: null,
  startDate: "2026-01-01",
  endDate: null,
  ...extra,
});
const txn = (id: string, extra: Partial<RecurringMatchTransaction> = {}): RecurringMatchTransaction => ({
  id,
  householdId: H,
  accountId: "acct-1",
  occurredOn: "2026-10-01",
  payee: "MAPLE PROPERTY MGMT ACH",
  amountCents: -150000,
  deleted: false,
  createdAt: `2026-10-01T00:00:0${id.length % 10}Z`,
  ...extra,
});
const plan = (items: RecurringMatchItem[], transactions: RecurringMatchTransaction[], extra: Partial<Parameters<typeof planRecurringLinks>[0]> = {}) =>
  planRecurringLinks({ householdId: H, items, transactions, links: [], dismissals: [], ...extra });

describe("recurring matching", () => {
  it("normalizes payees like payee rules: case and surrounding spaces ignored, contains", () => {
    expect(payeeMatchesItem("MAPLE PROPERTY MGMT", "  maple property ")).toBe(true);
    expect(payeeMatchesItem("Maple Market", "Maple Property")).toBe(false);
  });

  it("allows the larger of the percent and the fixed range, same sign only", () => {
    const rent = item();
    expect(amountMatchesItem(-157500, rent)).toBe(true); // exactly 5%
    expect(amountMatchesItem(-157501, rent)).toBe(false);
    expect(amountMatchesItem(150000, rent)).toBe(false);
    expect(amountMatchesItem(-160000, item({ toleranceCents: 10000 }))).toBe(true);
  });

  it("links within the date window and not outside it", () => {
    expect(plan([item()], [txn("t-in", { occurredOn: "2026-10-04" })]).add).toEqual([
      { itemId: "item-rent", transactionId: "t-in", occurrenceDate: "2026-10-01" },
    ]);
    expect(plan([item()], [txn("t-out", { occurredOn: "2026-10-05" })]).add).toEqual([]);
    // The window works backward too, including across a month end.
    expect(plan([item()], [txn("t-early", { occurredOn: "2026-09-29" })]).add[0]?.occurrenceDate).toBe("2026-10-01");
  });

  it("takes one transaction per occurrence, the closest date first", () => {
    const result = plan([item()], [txn("t-far", { occurredOn: "2026-10-03" }), txn("t-near", { occurredOn: "2026-10-01" })]);
    expect(result.add).toEqual([{ itemId: "item-rent", transactionId: "t-near", occurrenceDate: "2026-10-01" }]);
  });

  it("fills each occurrence of a weekly item once", () => {
    const weekly = item({ id: "item-gym", payeeMatch: "Gym", amountCents: -1000, cadence: "weekly", anchorDate: "2026-10-02" });
    const result = plan(
      [weekly],
      [
        txn("a", { payee: "Gym", amountCents: -1000, occurredOn: "2026-10-02" }),
        txn("b", { payee: "Gym", amountCents: -1000, occurredOn: "2026-10-09" }),
        txn("c", { payee: "Gym", amountCents: -1000, occurredOn: "2026-10-10" }),
      ],
    );
    expect(result.add.map((link) => `${link.transactionId}@${link.occurrenceDate}`).sort()).toEqual(["a@2026-10-02", "b@2026-10-09"]);
  });

  it("skips filled occurrences, linked or dismissed transactions, deleted rows, paused items, other accounts", () => {
    const base = [txn("t1")];
    expect(
      plan([item()], base, {
        links: [{ id: "l1", itemId: "item-rent", transactionId: "other", occurrenceDate: "2026-10-01", transactionDeleted: false }],
      }).add,
    ).toEqual([]);
    expect(
      plan([item()], base, {
        links: [{ id: "l1", itemId: "item-other", transactionId: "t1", occurrenceDate: "2026-10-01", transactionDeleted: false }],
      }).add,
    ).toEqual([]);
    expect(plan([item()], base, { dismissals: [{ itemId: "item-rent", transactionId: "t1" }] }).add).toEqual([]);
    expect(plan([item()], [txn("t1", { deleted: true })]).add).toEqual([]);
    expect(plan([item({ paused: true })], base).add).toEqual([]);
    expect(plan([item({ accountId: "acct-2" })], base).add).toEqual([]);
    expect(plan([item({ householdId: "house-2" })], base).add).toEqual([]);
    expect(plan([item({ startDate: "2026-11-01" })], base).add).toEqual([]);
  });

  it("frees an occurrence held only by a soft-deleted transaction", () => {
    const result = plan([item()], [txn("t-new")], {
      links: [{ id: "stale", itemId: "item-rent", transactionId: "t-old", occurrenceDate: "2026-10-01", transactionDeleted: true }],
    });
    expect(result.add).toEqual([{ itemId: "item-rent", transactionId: "t-new", occurrenceDate: "2026-10-01" }]);
    expect(result.drop).toEqual(["stale"]);
  });

  it("gives a transaction that fits two items to the closer amount", () => {
    const a = item({ id: "item-a", payeeMatch: "Maple", amountCents: -140000, tolerancePercent: 10 });
    const b = item({ id: "item-b", payeeMatch: "Maple", amountCents: -150000 });
    expect(plan([a, b], [txn("t1")]).add).toEqual([{ itemId: "item-b", transactionId: "t1", occurrenceDate: "2026-10-01" }]);
  });

  it("links by hand to the nearest open occurrence", () => {
    expect(occurrenceForManualLink(item(), "2026-10-20", new Set())._unsafeUnwrap()).toBe("2026-11-01");
    expect(occurrenceForManualLink(item(), "2026-10-20", new Set(["2026-11-01"]))._unsafeUnwrap()).toBe("2026-10-01");
    expect(occurrenceForManualLink(item({ startDate: "2027-06-01", anchorDate: "2027-06-01" }), "2026-10-20", new Set()).isErr()).toBe(true);
  });
});
