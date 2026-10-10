import {
  RANGE_LABELS,
  RANGE_PRESETS,
  SOURCE_LABELS,
  UNCATEGORIZED,
  UNKNOWN_MEMBER,
  activeFilterCount,
  centsToDollarText,
  filterHref,
  formatCents,
  resolveFilterRange,
  type SpendingFilter,
} from "@dollas/domain";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { FilterContext } from "@/slices/spending/load";
import { SavedFilters } from "./saved-filters";

/**
 * Search plus filters for Activity and the Spending dashboard (PEN-212). A
 * plain GET form, so every filter lives in the URL: shareable, bookmarkable,
 * and the back button works. The same keys drive list_transactions and
 * get_spending_breakdown.
 */

function Check({ name, value, checked, children }: { name: string; value: string; checked: boolean; children: ReactNode }) {
  return (
    <label className="flex min-h-9 items-center gap-2 rounded-md px-2 text-sm hover:bg-muted">
      <input type="checkbox" name={name} value={value} defaultChecked={checked} className="size-4 accent-[var(--primary)]" />
      <span className="min-w-0 truncate">{children}</span>
    </label>
  );
}

function Fieldset({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0 space-y-1">
      <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{legend}</legend>
      {children}
    </fieldset>
  );
}

const selectClass = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

type Chip = { label: string; href: string };

function chipsFor(path: string, anchor: string, ctx: FilterContext): Chip[] {
  const { filter, defaultRange, choices } = ctx;
  const without = (patch: Partial<SpendingFilter>) => filterHref(path, { ...filter, ...patch }, defaultRange) + anchor;
  const chips: Chip[] = [];
  const range = resolveFilterRange(filter, ctx.today);
  if (filter.range !== defaultRange) {
    const label = filter.range === "custom" ? `${range.from ?? "Start"} to ${range.to ?? "today"}` : RANGE_LABELS[filter.range];
    chips.push({ label, href: without({ range: defaultRange, from: null, to: null }) });
  }
  if (filter.search) chips.push({ label: `“${filter.search}”`, href: without({ search: "" }) });
  const categoryName = new Map<string, string>([[UNCATEGORIZED, "Uncategorized"]]);
  for (const group of choices.groups) for (const row of group.categories) categoryName.set(row.id, row.name);
  for (const row of choices.ungrouped) categoryName.set(row.id, row.name);
  const accountName = new Map(choices.accounts.map((row) => [row.id, row.name] as const));
  const groupName = new Map(choices.groups.map((row) => [row.id, row.name] as const));
  const memberName = new Map<string, string>([[UNKNOWN_MEMBER, "Unknown"], ...choices.members.map((row) => [row.id, row.name] as const)]);
  for (const id of filter.accountIds) chips.push({ label: accountName.get(id) ?? "Account", href: without({ accountIds: filter.accountIds.filter((x) => x !== id) }) });
  for (const id of filter.groupIds) chips.push({ label: `${groupName.get(id) ?? "Group"} (group)`, href: without({ groupIds: filter.groupIds.filter((x) => x !== id) }) });
  for (const id of filter.categoryIds) chips.push({ label: categoryName.get(id) ?? "Category", href: without({ categoryIds: filter.categoryIds.filter((x) => x !== id) }) });
  const role = filter.memberRole === "added" ? "Added by " : filter.memberRole === "categorized" ? "Categorized by " : "";
  for (const id of filter.memberIds) chips.push({ label: `${role}${memberName.get(id) ?? "Former member"}`, href: without({ memberIds: filter.memberIds.filter((x) => x !== id) }) });
  for (const source of filter.sources) chips.push({ label: SOURCE_LABELS[source], href: without({ sources: filter.sources.filter((x) => x !== source) }) });
  if (filter.recurring !== "any") chips.push({ label: filter.recurring === "linked" ? "Recurring" : "Not recurring", href: without({ recurring: "any" }) });
  if (filter.minCents != null || filter.maxCents != null) {
    const label =
      filter.minCents != null && filter.maxCents != null
        ? `${formatCents(filter.minCents)} to ${formatCents(filter.maxCents)}`
        : filter.minCents != null
          ? `${formatCents(filter.minCents)} or more`
          : `Up to ${formatCents(filter.maxCents ?? 0)}`;
    chips.push({ label, href: without({ minCents: null, maxCents: null }) });
  }
  return chips;
}

/** `anchor` (e.g. "#transactions") keeps the results in view after a filter change, which matters on a phone. */
export function FilterBar({
  path,
  ctx,
  anchor = "",
  searchPlaceholder = "Search payees and notes",
}: {
  path: string;
  ctx: FilterContext;
  anchor?: string;
  searchPlaceholder?: string;
}) {
  const { filter, choices } = ctx;
  const chips = chipsFor(path, anchor, ctx);
  const count = activeFilterCount(filter);
  const clearHref = path + anchor;
  return (
    <div className="space-y-3">
      <form action={path + anchor} method="get" className="space-y-3" role="search" aria-label="Filter transactions">
        <div className="flex flex-wrap items-center gap-2">
          <Input type="search" name="q" defaultValue={filter.search} placeholder={searchPlaceholder} aria-label="Search" className="h-9 min-w-0 flex-1 basis-48" maxLength={100} />
          <select name="range" defaultValue={filter.range} aria-label="Dates" className="h-9 rounded-md border border-input bg-background px-2 text-sm">
            {RANGE_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {RANGE_LABELS[preset]}
              </option>
            ))}
          </select>
          <Button type="submit" size="sm" className="h-9">
            Search
          </Button>
        </div>
        <details className="group @container rounded-lg border border-border">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm font-medium">
            <span>Filters{count > 0 ? ` (${count})` : ""}</span>
            <span className="text-xs text-muted-foreground group-open:hidden">Accounts, categories, people, source, amount</span>
          </summary>
          <div className="dl-sheet grid gap-5 border-t border-border p-3 @lg:grid-cols-2 @4xl:grid-cols-4">
            <Fieldset legend="Custom dates">
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1 text-xs text-muted-foreground">
                  From
                  <Input type="date" name="from" defaultValue={filter.from ?? ""} className="h-9" />
                </label>
                <label className="space-y-1 text-xs text-muted-foreground">
                  To
                  <Input type="date" name="to" defaultValue={filter.to ?? ""} className="h-9" />
                </label>
              </div>
              <p className="text-xs text-muted-foreground">Used when Dates is Custom dates.</p>
            </Fieldset>
            <Fieldset legend="Accounts">
              <div className="max-h-48 overflow-y-auto">
                {choices.accounts.map((account) => (
                  <Check key={account.id} name="account" value={account.id} checked={filter.accountIds.includes(account.id)}>
                    {account.name}
                    {account.archived ? " (archived)" : ""}
                  </Check>
                ))}
              </div>
            </Fieldset>
            <Fieldset legend="Categories and groups">
              <div className="max-h-48 overflow-y-auto">
                <Check name="category" value={UNCATEGORIZED} checked={filter.categoryIds.includes(UNCATEGORIZED)}>
                  Uncategorized
                </Check>
                {choices.groups.map((group) => (
                  <div key={group.id}>
                    <Check name="group" value={group.id} checked={filter.groupIds.includes(group.id)}>
                      <span className="font-medium">{group.name}</span> <span className="text-muted-foreground">(whole group)</span>
                    </Check>
                    <div className="pl-4">
                      {group.categories.map((row) => (
                        <Check key={row.id} name="category" value={row.id} checked={filter.categoryIds.includes(row.id)}>
                          {row.name}
                        </Check>
                      ))}
                    </div>
                  </div>
                ))}
                {choices.ungrouped
                  .filter((row) => row.name !== "Uncategorized" && row.name !== "Uncategorized income")
                  .map((row) => (
                    <Check key={row.id} name="category" value={row.id} checked={filter.categoryIds.includes(row.id)}>
                      {row.name}
                    </Check>
                  ))}
              </div>
            </Fieldset>
            <Fieldset legend="People">
              {choices.members.map((member) => (
                <Check key={member.id} name="member" value={member.id} checked={filter.memberIds.includes(member.id)}>
                  {member.name}
                </Check>
              ))}
              <Check name="member" value={UNKNOWN_MEMBER} checked={filter.memberIds.includes(UNKNOWN_MEMBER)}>
                Unknown (before this was recorded)
              </Check>
              <select name="by" defaultValue={filter.memberRole} aria-label="Who" className={`${selectClass} mt-1`}>
                <option value="any">Added or categorized it</option>
                <option value="added">Added it (entered, imported, or synced)</option>
                <option value="categorized">Categorized it</option>
              </select>
            </Fieldset>
            <Fieldset legend="Source">
              {(["manual", "csv", "bank"] as const).map((source) => (
                <Check key={source} name="source" value={source} checked={filter.sources.includes(source)}>
                  {SOURCE_LABELS[source]}
                </Check>
              ))}
            </Fieldset>
            <Fieldset legend="Recurring">
              <select name="recurring" defaultValue={filter.recurring} aria-label="Recurring" className={selectClass}>
                <option value="any">Any</option>
                <option value="linked">Linked to a recurring item</option>
                <option value="not_linked">Not recurring</option>
              </select>
            </Fieldset>
            <Fieldset legend="Amount (either direction)">
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1 text-xs text-muted-foreground">
                  At least
                  <Input name="min" inputMode="decimal" placeholder="$0" defaultValue={filter.minCents != null ? centsToDollarText(filter.minCents) : ""} className="h-9" />
                </label>
                <label className="space-y-1 text-xs text-muted-foreground">
                  At most
                  <Input name="max" inputMode="decimal" placeholder="Any" defaultValue={filter.maxCents != null ? centsToDollarText(filter.maxCents) : ""} className="h-9" />
                </label>
              </div>
            </Fieldset>
            <div className="flex items-end gap-2 @lg:col-span-2 @4xl:col-span-4">
              <Button type="submit" size="sm">
                Apply filters
              </Button>
              <Link href={clearHref} className="tap text-sm font-medium text-primary underline-offset-4 hover:underline">
                Clear all
              </Link>
            </div>
          </div>
        </details>
      </form>
      {chips.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label="Active filters">
          {chips.map((chip) => (
            <li key={`${chip.label}-${chip.href}`}>
              <Link
                href={chip.href}
                className="tap inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-3 py-1 text-xs text-secondary-foreground hover:bg-muted"
                aria-label={`Remove filter ${chip.label}`}
              >
                {chip.label} <span aria-hidden="true">×</span>
              </Link>
            </li>
          ))}
          <li>
            <Link href={clearHref} className="tap inline-flex px-2 py-1 text-xs font-medium text-primary underline-offset-4 hover:underline">
              Clear all
            </Link>
          </li>
        </ul>
      ) : null}
      <SavedFilters path={path} anchor={anchor} ctx={ctx} />
    </div>
  );
}
