import { filterHref, formatCents, type SpendingFilter, type TrendBucket } from "@dollas/domain";
import Link from "next/link";
import { ChartLegend, ChartRows } from "@/components/charts/chart-rows";
import { compactCents, trendRows, trendSummary } from "@/components/charts/chart-text";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { NamedSlice, SpendingDashboard } from "@/slices/spending/service";

/**
 * The Spending dashboard on History (PEN-212). Every number respects the
 * filter; categories, groups, accounts, and people drill into Activity with
 * the same filter plus that one condition. Chart styles match History: sage
 * bars, the current partial bucket hatched amber "so far", and "Not comparable
 * yet" for it.
 */

/** A phone shows the latest eight buckets; wider screens show them all. */
const PHONE_BUCKETS = 8;
const BAR_HEIGHT = 120;

function TrendChart({ buckets, unit }: { buckets: TrendBucket[]; unit: "week" | "month" }) {
  const max = Math.max(1, ...buckets.map((bucket) => bucket.spentCents));
  const phoneFrom = Math.max(0, buckets.length - PHONE_BUCKETS);
  return (
    <figure>
      <figcaption className="sr-only">{trendSummary(buckets, unit)}</figcaption>
      <ChartLegend
        items={[
          { label: `Spent ${unit === "week" ? "each week" : "each month"}`, swatch: "bg-bar" },
          { label: "So far", swatch: "bar-partial" },
        ]}
      />
      <div aria-hidden="true" data-chart="trend" className="flex items-end gap-1.5 sm:gap-2">
        {buckets.map((bucket, index) => {
          const height = Math.round((bucket.spentCents / max) * BAR_HEIGHT);
          return (
            <div key={bucket.from} className={`min-w-0 flex-1 ${index < phoneFrom ? "hidden sm:block" : ""}`}>
              <div className="flex items-end justify-center" style={{ height: BAR_HEIGHT + 4 }}>
                <div
                  className={`dl-bar w-[55%] max-w-6 rounded-t-sm ${bucket.partial ? "bar-partial" : "bg-bar"}`}
                  style={{ height: Math.max(bucket.spentCents > 0 ? 4 : 0, height), ["--i" as string]: index }}
                />
              </div>
              <p className="mt-2 text-center text-xs leading-tight font-medium">{bucket.label}</p>
              <p className="text-center text-xs tabular-nums text-muted-foreground">{compactCents(bucket.spentCents)}</p>
              <p className={`text-center text-xs font-medium ${bucket.partial ? "text-amber-800" : "invisible"}`}>so far</p>
            </div>
          );
        })}
      </div>
      <ChartRows title={unit === "week" ? "Week by week" : "Month by month"} rows={trendRows(buckets, unit)} visible={4} />
    </figure>
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
  const drill = (patch: Partial<SpendingFilter>) => `${filterHref("/activity", { ...filter, ...patch }, "all")}#transactions`;
  const spent = board.totals.spentCents;
  const range = board.from || board.to ? `${board.from ?? "the start"} to ${board.to ?? "today"}` : "all dates";
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
