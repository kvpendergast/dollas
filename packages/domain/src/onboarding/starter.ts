/**
 * A starter set of category groups and categories (PEN-204), offered in one
 * click when a household has no categories of its own yet (none, or only the
 * "Uncategorized" fallbacks import and sync create). Adding it is idempotent:
 * anything already there by name (case-insensitive) is skipped.
 */

export type StarterKind = "expense" | "income";
export type StarterGroup = { name: string; categories: ReadonlyArray<{ name: string; kind: StarterKind }> };

const expense = (name: string) => ({ name, kind: "expense" as const });

export const STARTER_CATEGORIES: readonly StarterGroup[] = [
  { name: "Income", categories: [{ name: "Paychecks", kind: "income" }, { name: "Other income", kind: "income" }] },
  { name: "Home", categories: [expense("Rent or mortgage"), expense("Utilities"), expense("Internet and phone"), expense("Household supplies")] },
  { name: "Food", categories: [expense("Groceries"), expense("Dining out")] },
  { name: "Getting around", categories: [expense("Gas and transit"), expense("Car")] },
  { name: "Health", categories: [expense("Medical"), expense("Insurance")] },
  { name: "Fun", categories: [expense("Entertainment"), expense("Subscriptions"), expense("Travel")] },
  { name: "Giving and gifts", categories: [expense("Gifts"), expense("Donations")] },
];

/** The fallback categories import and sync create; they do not count as a household's own. */
export const FALLBACK_CATEGORIES: ReadonlyArray<{ name: string; kind: StarterKind }> = [
  { name: "Uncategorized", kind: "expense" },
  { name: "Uncategorized income", kind: "income" },
];

export function isFallbackCategory(row: { name: string; kind: string }): boolean {
  return FALLBACK_CATEGORIES.some((fallback) => fallback.name === row.name && fallback.kind === row.kind);
}

/** True when the household has no categories of its own: none, or only the fallbacks. */
export function needsStarterCategories(categories: ReadonlyArray<{ name: string; kind: string }>): boolean {
  return categories.every(isFallbackCategory);
}

export type StarterPlan = {
  groups: string[];
  categories: Array<{ name: string; kind: StarterKind; groupName: string }>;
  skipped: number;
};

const key = (name: string) => name.trim().toLowerCase();

/** What adding the starter set would create, given what exists. Re-running after it was added plans nothing. */
export function planStarterCategories(existing: {
  groups: ReadonlyArray<{ name: string }>;
  categories: ReadonlyArray<{ name: string }>;
}): StarterPlan {
  const groupNames = new Set(existing.groups.map((group) => key(group.name)));
  const categoryNames = new Set(existing.categories.map((row) => key(row.name)));
  const plan: StarterPlan = { groups: [], categories: [], skipped: 0 };
  for (const group of STARTER_CATEGORIES) {
    const missing = group.categories.filter((row) => !categoryNames.has(key(row.name)));
    plan.skipped += group.categories.length - missing.length;
    if (missing.length === 0) continue;
    if (!groupNames.has(key(group.name))) plan.groups.push(group.name);
    for (const row of missing) plan.categories.push({ ...row, groupName: group.name });
  }
  return plan;
}
