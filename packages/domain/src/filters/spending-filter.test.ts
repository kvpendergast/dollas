import { describe, expect, it } from "vitest";
import {
  activeFilterCount,
  defineSpendingFilter,
  emptySpendingFilter,
  filterFromSearchParams,
  filterHref,
  filterToSearchParams,
  parseDollarsToCents,
  resolveFilterRange,
} from "./spending-filter";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("spending filter schema", () => {
  it("fills defaults and de-duplicates", () => {
    const filter = defineSpendingFilter({ accountIds: [A, A, B], sources: ["csv", "csv"] })._unsafeUnwrap();
    expect(filter).toMatchObject({ range: "all", from: null, to: null, accountIds: [A, B], sources: ["csv"], memberRole: "any", recurring: "any", search: "" });
  });

  it("accepts uncategorized and unknown member markers", () => {
    const filter = defineSpendingFilter({ categoryIds: ["uncategorized", A], memberIds: ["unknown", "user_abc-123"] })._unsafeUnwrap();
    expect(filter.categoryIds).toEqual(["uncategorized", A]);
    expect(filter.memberIds).toEqual(["unknown", "user_abc-123"]);
  });

  it("refuses bad input with member-facing messages", () => {
    expect(defineSpendingFilter({ range: "custom", from: "2026-03-01", to: "2026-02-01" })._unsafeUnwrapErr().message).toMatch(/on or before/);
    expect(defineSpendingFilter({ range: "this_month", from: "2026-03-01" })._unsafeUnwrapErr().message).toMatch(/custom/);
    expect(defineSpendingFilter({ minCents: 500, maxCents: 100 })._unsafeUnwrapErr().message).toMatch(/smallest/);
    expect(defineSpendingFilter({ minCents: 1.5 })._unsafeUnwrapErr().message).toMatch(/whole cents/);
    expect(defineSpendingFilter({ accountIds: ["nope"] }).isErr()).toBe(true);
    expect(defineSpendingFilter({ search: "x".repeat(101) })._unsafeUnwrapErr().message).toMatch(/100 characters/);
    expect(defineSpendingFilter({ range: "custom", from: "2026-02-30" }).isErr()).toBe(true);
  });

  it("trims search", () => {
    expect(defineSpendingFilter({ search: "  coffee " })._unsafeUnwrap().search).toBe("coffee");
  });

  it("counts active conditions beyond the date range", () => {
    expect(activeFilterCount(emptySpendingFilter("this_month"))).toBe(0);
    const filter = defineSpendingFilter({ accountIds: [A], categoryIds: [B], groupIds: [A], sources: ["bank"], recurring: "linked", minCents: 100, memberIds: ["unknown"] })._unsafeUnwrap();
    expect(activeFilterCount(filter)).toBe(6);
  });
});

describe("date presets in the household's today", () => {
  const today = "2026-03-10";
  it.each([
    ["all", { from: null, to: null }],
    ["this_month", { from: "2026-03-01", to: "2026-03-10" }],
    ["last_month", { from: "2026-02-01", to: "2026-02-28" }],
    ["last_90_days", { from: "2025-12-11", to: "2026-03-10" }],
    ["this_year", { from: "2026-01-01", to: "2026-03-10" }],
    ["last_year", { from: "2025-01-01", to: "2025-12-31" }],
  ] as const)("%s", (range, expected) => {
    expect(resolveFilterRange({ range, from: null, to: null }, today)).toEqual(expected);
  });
  it("last month from January is December, and leap Februaries have 29 days", () => {
    expect(resolveFilterRange({ range: "last_month", from: null, to: null }, "2026-01-15")).toEqual({ from: "2025-12-01", to: "2025-12-31" });
    expect(resolveFilterRange({ range: "last_month", from: null, to: null }, "2028-03-01")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });
  it("custom passes through open ends", () => {
    expect(resolveFilterRange({ range: "custom", from: "2026-01-05", to: null }, today)).toEqual({ from: "2026-01-05", to: null });
  });
});

describe("URL encoding", () => {
  it("round-trips every field and leaves out defaults", () => {
    const filter = defineSpendingFilter({
      range: "custom",
      from: "2026-01-01",
      to: "2026-01-31",
      accountIds: [A],
      categoryIds: ["uncategorized", B],
      groupIds: [A],
      memberIds: ["unknown", "u_1"],
      memberRole: "categorized",
      sources: ["csv", "bank"],
      recurring: "not_linked",
      minCents: 2550,
      maxCents: 100000,
      search: "corner market",
    })._unsafeUnwrap();
    const params = filterToSearchParams(filter, "all");
    expect(params.get("min")).toBe("25.50");
    expect(params.get("max")).toBe("1000");
    expect(params.getAll("category")).toEqual(["uncategorized", B]);
    expect(filterFromSearchParams(params, "all")).toEqual(filter);
    expect(filterToSearchParams(emptySpendingFilter("this_month"), "this_month").toString()).toBe("");
    expect(filterToSearchParams(emptySpendingFilter("all"), "this_month").toString()).toBe("range=all");
  });

  it("reads Next.js search params (strings, arrays, commas) and drops junk", () => {
    const filter = filterFromSearchParams(
      { account: [A, "junk"], category: `${B},uncategorized`, source: ["bank", "fax"], recurring: "maybe", min: "abc", max: "$1,200", q: "  tea ", range: "nope" },
      "this_month",
    );
    expect(filter).toMatchObject({ range: "this_month", accountIds: [A], categoryIds: [B, "uncategorized"], sources: ["bank"], recurring: "any", minCents: null, maxCents: 120000, search: "tea" });
  });

  it("treats from/to without a range as custom, and swaps reversed bounds", () => {
    expect(filterFromSearchParams({ from: "2026-02-10", to: "2026-02-01" }, "all")).toMatchObject({ range: "custom", from: "2026-02-01", to: "2026-02-10" });
    expect(filterFromSearchParams({ min: "50", max: "10" }, "all")).toMatchObject({ minCents: 1000, maxCents: 5000 });
    expect(filterFromSearchParams({ range: "custom" }, "this_month").range).toBe("this_month");
  });

  it("builds hrefs with extra params such as the page", () => {
    const filter = defineSpendingFilter({ accountIds: [A] })._unsafeUnwrap();
    expect(filterHref("/activity", filter, "all", { page: "2" })).toBe(`/activity?account=${A}&page=2`);
    expect(filterHref("/activity", emptySpendingFilter(), "all")).toBe("/activity");
  });

  it("parses dollar amounts to cents", () => {
    expect(parseDollarsToCents("25")).toBe(2500);
    expect(parseDollarsToCents("25.5")).toBe(2550);
    expect(parseDollarsToCents("$1,234.56")).toBe(123456);
    expect(parseDollarsToCents("-4")).toBeNull();
    expect(parseDollarsToCents("1.234")).toBeNull();
  });
});

describe("saved filter names", () => {
  it("trims, collapses spaces, and limits length", async () => {
    const { defineSavedFilterName } = await import("./spending-filter");
    expect(defineSavedFilterName("  Coffee   runs ")._unsafeUnwrap()).toBe("Coffee runs");
    expect(defineSavedFilterName("   ")._unsafeUnwrapErr().message).toBe("Name the filter.");
    expect(defineSavedFilterName("x".repeat(61)).isErr()).toBe(true);
  });
});
