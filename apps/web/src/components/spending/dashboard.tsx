import { filterHref, formatCents, type SpendingFilter, type TrendBucket } from "@dollas/domain";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { NamedSlice, SpendingDashboard } from "@/slices/spending/service";

/**
 * The Spending dashboard on History (PEN-212). Every number respects the
 * filter; categories, groups, accounts, and people drill into Activity with
 * the same filter plus that one condition. Chart styles match History: sage
 * bars, the current partial bucket hatched amber "so far", and "Not comparable
 * yet" for it.
 */

function tone(direction: "less" | "more" | "same"): string {
  if (direction === "less") return "text-income";
  if (direction === "more") return "text-over";
  return "text-muted-foreground";
}

function TrendChart({ buckets, unit }: { buckets: TrendBucket[]; unit: "week" | "month" }) {
  const max = Math.max(1, ...buckets.map((bucket) => bucket.spentCents));
  const previous = unit === "week" ? "than the week before" : "than the month before";
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-sm bg-bar" />
          Spent {unit === "week" ? "each week" : "each month"}
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="bar-partial inline-block h-3 w-3 rounded-sm" />
          So far
        </span>
      </div>
      <div className="overflow-x-auto pb-2">
        <div className="flex items-end gap-2" style={{ minWidth: `${buckets.length * 64}px` }} role="list" aria-label={`Spending by ${unit}`}>
          {buckets.map((bucket) => {
            const height = Math.round((bucket.spentCents / max) * 120);
            return (
              <div key={bucket.from} role="listitem" className="w-14 shrink-0">
                <div className="flex h-32 items-end justify-center">
                  <div
                    className={bucket.partial ? "bar-partial w-5 rounded-t-sm" : "w-5 rounded-t-sm bg-bar"}
                    style={{ height: Math.max(bucket.spentCents > 0 ? 4 : 0, height) }}
                    title={`${bucket.partial ? "So far " : ""}${formatCents(bucket.spentCents)}`}
                  />
                </div>
                <p className="mt-2 text-center text-xs font-medium">{bucket.label}</p>
                <p className="text-center font-serif text-xs tabular-nums">{formatCents(bucket.spentCents)}</p>
                {bucket.partial ? (
                  <p className="text-center text-[11px] font-medium text-amber-800">so far</p>
                ) : (
                  <p className="text-center text-[11px] text-transparent" aria-hidden="true">
                    so far
                  </p>
                )}
                {bucket.change == null ? null : bucket.change.comparable ? (
                  <p className={`text-center text-[11px] leading-tight ${tone(bucket.change.direction)}`} title={previous}>
                    {bucket.change.direction === "same"
                      ? "Same"
                      : `${formatCents(Math.abs(bucket.change.deltaCents))} ${bucket.change.direction}`}
                  </p>
                ) : (
                  <p className="text-center text-[11px] leading-tight text-muted-foreground">Not comparable yet</p>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SliceList({
  title,
  description,
  slices,
  total,
  hrefFor,
  empty = "No spending here.",
}: {
  title: string;
  description?: string;
  slices: Array<NamedSlice & { groupName?: string | null }>;
  total: number;
  hrefFor: (slice: NamedSlice) => string | null;
  empty?: string;
}) {
  const rows = slices.filter((slice) => slice.spentCents > 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="space-y-3">
            {rows.map((slice) => {
              const share = total > 0 ? Math.round((slice.spentCents / total) * 100) : 0;
              const href = hrefFor(slice);
              const label = slice.groupName ? `${slice.groupName} · ${slice.name}` : slice.name;
              return (
                <li key={slice.key ?? "none"} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    {href ? (
                      <Link href={href} className="min-w-0 truncate text-primary underline-offset-4 hover:underline" title={`See these in Activity`}>
                        {label}
                      </Link>
                    ) : (
                      <span className="min-w-0 truncate">{label}</span>
                    )}
                    <span className="shrink-0 tabular-nums">
                      {formatCents(slice.spentCents)} <span className="text-xs text-muted-foreground">{share}%</span>
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                    <div className="h-full rounded-full bg-bar" style={{ width: `${Math.max(share, 1)}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function SpendingDashboardView({ board }: { board: SpendingDashboard }) {
  const filter = board.filter;
  const drill = (patch: Partial<SpendingFilter>) => filterHref("/activity", { ...filter, ...patch }, "all");
  const spent = board.totals.spentCents;
  const range = board.from || board.to ? `${board.from ?? "the start"} to ${board.to ?? "today"}` : "all dates";
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        <Card size="sm">
          <CardHeader>
            <CardDescription>Spent</CardDescription>
            <CardTitle className="font-serif text-3xl tabular-nums">{formatCents(spent)}</CardTitle>
          </CardHeader>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription>Income</CardDescription>
            <CardTitle className="font-serif text-3xl tabular-nums text-income">{formatCents(board.totals.incomeCents)}</CardTitle>
          </CardHeader>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription>Income minus spending</CardDescription>
            <CardTitle className={`font-serif text-3xl tabular-nums ${board.totals.netCents < 0 ? "text-over" : ""}`}>{formatCents(board.totals.netCents)}</CardTitle>
          </CardHeader>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription>Transactions</CardDescription>
            <CardTitle className="font-serif text-3xl tabular-nums">
              <Link href={drill({})} className="underline-offset-4 hover:underline">
                {board.totals.transactionCount}
              </Link>
            </CardTitle>
          </CardHeader>
        </Card>
      </div>
      <p className="text-xs text-muted-foreground">
        {range}. Spending and income count as Home does: expense categories are spending, income categories are income, transfers are
        neither.
      </p>
      <Card>
        <CardHeader>
          <CardTitle>Trend</CardTitle>
          <CardDescription>
            {board.trend.unit === "week" ? "Week by week (weeks start Monday)" : "Month by month"}
            {board.trend.truncated ? ", the last three years" : ""}.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TrendChart buckets={board.trend.buckets} unit={board.trend.unit} />
        </CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <SliceList
          title="By category"
          slices={board.byCategory}
          total={spent}
          hrefFor={(slice) => (slice.key ? drill({ categoryIds: [slice.key], groupIds: [] }) : null)}
        />
        <div className="space-y-4">
          <SliceList
            title="By group"
            slices={board.byGroup}
            total={spent}
            hrefFor={(slice) => (slice.key ? drill({ groupIds: [slice.key], categoryIds: [] }) : null)}
          />
          <SliceList title="By account" slices={board.byAccount} total={spent} hrefFor={(slice) => (slice.key ? drill({ accountIds: [slice.key] }) : null)} />
          <SliceList
            title="By person"
            description={board.memberRole === "categorized" ? "Who categorized it." : "Who added it: entered it, imported the CSV, or ran the bank sync. Unknown is from before this was recorded."}
            slices={board.byMember}
            total={spent}
            hrefFor={(slice) => drill({ memberIds: [slice.key ?? "unknown"], memberRole: board.memberRole })}
          />
        </div>
      </div>
    </div>
  );
}
