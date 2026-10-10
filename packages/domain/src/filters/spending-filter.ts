import { err, ok, type Result } from "neverthrow";
import { z } from "zod";
import { InvalidFilterError } from "../errors";
import { addDays, daysInMonth, isCivilDate } from "../recurring/schedule";

/**
 * One filter model for Activity, the Spending dashboard, saved filters, and the
 * MCP tools (PEN-212). Money is integer cents; dates are civil dates in the
 * household's time zone.
 *
 * - range: a preset resolved against the household's today, or custom from/to.
 * - accountIds: any of these accounts.
 * - categoryIds / groupIds: a transaction matches when any of its category
 *   lines is in one of the categories or groups; "uncategorized" matches the
 *   fallback categories import and sync use ("Uncategorized" and
 *   "Uncategorized income"). Both empty: no category condition.
 * - memberIds with memberRole: who added the transaction (entered it,
 *   imported the CSV, or ran the bank sync), who last set its categories, or
 *   either. "unknown" matches rows from before attribution was recorded.
 * - sources: manual (neither CSV nor bank), csv (from a CSV import), bank
 *   (reported by a bank sync). A CSV row a sync matched is both csv and bank.
 * - recurring: linked to a recurring item, or not.
 * - minCents / maxCents: the transaction's size (absolute amount), inclusive.
 * - search: text in the payee or the note, ignoring case.
 */

export const RANGE_PRESETS = ["all", "this_month", "last_month", "last_90_days", "this_year", "last_year", "custom"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const RANGE_LABELS: Record<RangePreset, string> = {
  all: "All dates",
  this_month: "This month",
  last_month: "Last month",
  last_90_days: "Last 90 days",
  this_year: "This year",
  last_year: "Last year",
  custom: "Custom dates",
};
export const FILTER_SOURCES = ["manual", "csv", "bank"] as const;
export type FilterSource = (typeof FILTER_SOURCES)[number];
export const SOURCE_LABELS: Record<FilterSource, string> = { manual: "Entered by hand", csv: "CSV import", bank: "Bank sync" };
export const MEMBER_ROLES = ["any", "added", "categorized"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];
export const RECURRING_CHOICES = ["any", "linked", "not_linked"] as const;
export type RecurringChoice = (typeof RECURRING_CHOICES)[number];
export const UNCATEGORIZED = "uncategorized";
export const UNKNOWN_MEMBER = "unknown";
export const SEARCH_MAX_LENGTH = 100;
const MAX_CENTS = 100_000_000_00;

const civilDate = z.string().refine(isCivilDate, "Use a date like 2026-01-31.");
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Not a known id.");
const memberId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Not a known member.");
const cents = z.number().int("Amounts are whole cents.").min(0, "Amounts are sizes, so zero or more.").max(MAX_CENTS);

export const spendingFilterSchema = z
  .object({
    range: z.enum(RANGE_PRESETS).default("all"),
    from: civilDate.nullable().default(null),
    to: civilDate.nullable().default(null),
    accountIds: z.array(uuid).max(50).default([]),
    categoryIds: z.array(z.union([z.literal(UNCATEGORIZED), uuid])).max(200).default([]),
    groupIds: z.array(uuid).max(100).default([]),
    memberIds: z.array(z.union([z.literal(UNKNOWN_MEMBER), memberId])).max(20).default([]),
    memberRole: z.enum(MEMBER_ROLES).default("any"),
    sources: z.array(z.enum(FILTER_SOURCES)).max(3).default([]),
    recurring: z.enum(RECURRING_CHOICES).default("any"),
    minCents: cents.nullable().default(null),
    maxCents: cents.nullable().default(null),
    search: z.string().trim().max(SEARCH_MAX_LENGTH, `Search for ${SEARCH_MAX_LENGTH} characters or fewer.`).default(""),
  })
  .superRefine((value, ctx) => {
    if (value.range !== "custom" && (value.from || value.to)) {
      ctx.addIssue({ code: "custom", message: "From and to dates go with custom dates.", path: ["range"] });
    }
    if (value.from && value.to && value.from > value.to) {
      ctx.addIssue({ code: "custom", message: "The from date must be on or before the to date.", path: ["from"] });
    }
    if (value.minCents != null && value.maxCents != null && value.minCents > value.maxCents) {
      ctx.addIssue({ code: "custom", message: "The smallest amount must not be more than the largest.", path: ["minCents"] });
    }
  });

export type SpendingFilter = z.output<typeof spendingFilterSchema>;
export type SpendingFilterInput = z.input<typeof spendingFilterSchema>;

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Validate any input (form, saved JSON, tool arguments) into a filter, or a member-safe error. */
export function defineSpendingFilter(input: unknown): Result<SpendingFilter, InvalidFilterError> {
  const parsed = spendingFilterSchema.safeParse(input ?? {});
  if (!parsed.success) return err(new InvalidFilterError(parsed.error.issues[0]?.message ?? "That filter is not valid."));
  const value = parsed.data;
  return ok({
    ...value,
    accountIds: unique(value.accountIds),
    categoryIds: unique(value.categoryIds),
    groupIds: unique(value.groupIds),
    memberIds: unique(value.memberIds),
    sources: unique(value.sources),
  });
}

export function emptySpendingFilter(range: RangePreset = "all"): SpendingFilter {
  return spendingFilterSchema.parse({ range });
}

/** The inclusive civil-date bounds a filter covers today. Null means open-ended. */
export function resolveFilterRange(filter: Pick<SpendingFilter, "range" | "from" | "to">, today: string): { from: string | null; to: string | null } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const pad = (n: number) => String(n).padStart(2, "0");
  switch (filter.range) {
    case "all":
      return { from: null, to: null };
    case "this_month":
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case "last_month": {
      const y = month === 1 ? year - 1 : year;
      const m = month === 1 ? 12 : month - 1;
      return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(daysInMonth(y, m))}` };
    }
    case "last_90_days":
      return { from: addDays(today, -89), to: today };
    case "this_year":
      return { from: `${year}-01-01`, to: today };
    case "last_year":
      return { from: `${year - 1}-01-01`, to: `${year - 1}-12-31` };
    case "custom":
      return { from: filter.from, to: filter.to };
  }
}

/** How many conditions beyond the date range are set (for a "Filters (3)" button). */
export function activeFilterCount(filter: SpendingFilter): number {
  return (
    (filter.accountIds.length > 0 ? 1 : 0) +
    (filter.categoryIds.length + filter.groupIds.length > 0 ? 1 : 0) +
    (filter.memberIds.length > 0 ? 1 : 0) +
    (filter.sources.length > 0 ? 1 : 0) +
    (filter.recurring !== "any" ? 1 : 0) +
    (filter.minCents != null || filter.maxCents != null ? 1 : 0)
  );
}

/** "25", "25.5", "$1,234.56" → cents. Null when it is not a plain non-negative amount. */
export function parseDollarsToCents(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, "");
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

export function centsToDollarText(value: number): string {
  const whole = Math.floor(value / 100);
  const rest = value % 100;
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, "0")}`;
}

type Params = Record<string, string | string[] | undefined> | URLSearchParams;

function raw(params: Params, key: string): string[] {
  const value = params instanceof URLSearchParams ? params.getAll(key) : params[key];
  return value == null ? [] : Array.isArray(value) ? value : [value];
}

/** A list key: repeated, comma-separated, or both. */
function all(params: Params, key: string): string[] {
  return raw(params, key).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
}

/**
 * Read a filter from URL search params (Activity and the dashboard share the
 * same keys). Lenient: a hand-edited or stale value is dropped, not an error.
 */
export function filterFromSearchParams(params: Params, defaultRange: RangePreset): SpendingFilter {
  const one = (key: string) => raw(params, key)[0]?.trim() || null;
  const keep = <T>(schema: z.ZodType<T>, values: string[]): T[] => values.flatMap((value) => {
    const parsed = schema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  const from = one("from");
  const to = one("to");
  let range = (RANGE_PRESETS as readonly string[]).includes(one("range") ?? "") ? (one("range") as RangePreset) : defaultRange;
  const validFrom = from && isCivilDate(from) ? from : null;
  const validTo = to && isCivilDate(to) ? to : null;
  if ((validFrom || validTo) && one("range") == null) range = "custom";
  const custom = range === "custom";
  const draft = {
    range: custom && !validFrom && !validTo ? defaultRange : range,
    from: custom ? validFrom : null,
    to: custom ? validTo : null,
    accountIds: keep(uuid, all(params, "account")),
    categoryIds: keep(z.union([z.literal(UNCATEGORIZED), uuid]), all(params, "category")),
    groupIds: keep(uuid, all(params, "group")),
    memberIds: keep(z.union([z.literal(UNKNOWN_MEMBER), memberId]), all(params, "member")),
    memberRole: (MEMBER_ROLES as readonly string[]).includes(one("by") ?? "") ? (one("by") as MemberRole) : "any",
    sources: keep(z.enum(FILTER_SOURCES), all(params, "source")),
    recurring: (RECURRING_CHOICES as readonly string[]).includes(one("recurring") ?? "") ? (one("recurring") as RecurringChoice) : "any",
    minCents: one("min") ? parseDollarsToCents(one("min") ?? "") : null,
    maxCents: one("max") ? parseDollarsToCents(one("max") ?? "") : null,
    search: (one("q") ?? "").slice(0, SEARCH_MAX_LENGTH),
  };
  if (draft.from && draft.to && draft.from > draft.to) [draft.from, draft.to] = [draft.to, draft.from];
  if (draft.minCents != null && draft.maxCents != null && draft.minCents > draft.maxCents) [draft.minCents, draft.maxCents] = [draft.maxCents, draft.minCents];
  const defined = defineSpendingFilter(draft);
  return defined.isOk() ? defined.value : emptySpendingFilter(defaultRange);
}

/** URL search params for a filter, leaving out the page's defaults so links stay short. */
export function filterToSearchParams(filter: SpendingFilter, defaultRange: RangePreset): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.search) params.set("q", filter.search);
  if (filter.range !== defaultRange || filter.range === "custom") params.set("range", filter.range);
  if (filter.range === "custom") {
    if (filter.from) params.set("from", filter.from);
    if (filter.to) params.set("to", filter.to);
  }
  for (const id of filter.accountIds) params.append("account", id);
  for (const id of filter.categoryIds) params.append("category", id);
  for (const id of filter.groupIds) params.append("group", id);
  for (const id of filter.memberIds) params.append("member", id);
  if (filter.memberRole !== "any") params.set("by", filter.memberRole);
  for (const source of filter.sources) params.append("source", source);
  if (filter.recurring !== "any") params.set("recurring", filter.recurring);
  if (filter.minCents != null) params.set("min", centsToDollarText(filter.minCents));
  if (filter.maxCents != null) params.set("max", centsToDollarText(filter.maxCents));
  return params;
}

/** A link to `path` with this filter and extra params (e.g. page=2). */
export function filterHref(path: string, filter: SpendingFilter, defaultRange: RangePreset, extra: Record<string, string> = {}): string {
  const params = filterToSearchParams(filter, defaultRange);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export const SAVED_FILTER_NAME_MAX = 60;

/** A saved filter's name: trimmed, 1-60 characters, spaces collapsed. */
export function defineSavedFilterName(input: string): Result<string, InvalidFilterError> {
  const name = input.trim().replace(/\s+/g, " ");
  if (name.length === 0) return err(new InvalidFilterError("Name the filter."));
  if (name.length > SAVED_FILTER_NAME_MAX) return err(new InvalidFilterError(`Use ${SAVED_FILTER_NAME_MAX} characters or fewer for the name.`));
  return ok(name);
}
