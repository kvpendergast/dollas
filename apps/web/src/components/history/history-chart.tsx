import { shortMonthLabel, type HistoryColumn } from "@dollas/domain";
import { ChartLegend, ChartRows } from "@/components/charts/chart-rows";
import { compactCents, historyRows, historySummary } from "@/components/charts/chart-text";

/**
 * History (PEN-208 layout). Vertical columns, prior year #b7c9be beside this
 * year #3f6b54, the current partial month hatched amber "so far". Columns are
 * fluid: a phone shows the latest six months, wider screens all twelve, with no
 * fixed min width and no labels under 12px. Deltas read as text with a sign
 * and the month they compare with in the list under the bars; the bars are
 * decorative for screen readers, which get a summary and the list.
 */
const PHONE_COLUMNS = 6;
const BAR_HEIGHT = 144;

export function HistoryChart({ columns }: { columns: HistoryColumn[] }) {
  const max = Math.max(1, ...columns.flatMap((column) => [column.spentCents, column.priorYearSpentCents]));
  const phoneFrom = Math.max(0, columns.length - PHONE_COLUMNS);
  return (
    <figure>
      <figcaption className="sr-only">{historySummary(columns)}</figcaption>
      <ChartLegend
        items={[
          { label: "Prior year", swatch: "bg-prior" },
          { label: "This year", swatch: "bg-bar" },
          { label: "So far", swatch: "bar-partial" },
        ]}
      />
      <div aria-hidden="true" data-chart="history" className="grid grid-cols-6 items-end gap-2 sm:grid-cols-12 sm:gap-1.5 lg:gap-3">
        {columns.map((column, index) => {
          const current = Math.round((column.spentCents / max) * BAR_HEIGHT);
          const prior = Math.round((column.priorYearSpentCents / max) * BAR_HEIGHT);
          return (
            <div key={`${column.year}-${column.month}`} className={`min-w-0 ${index < phoneFrom ? "hidden sm:block" : ""}`}>
              <div className="flex items-end justify-center gap-[3px]" style={{ height: BAR_HEIGHT + 4 }}>
                <div
                  className="dl-bar w-[38%] max-w-4 rounded-t-sm bg-prior"
                  style={{ height: Math.max(column.priorYearSpentCents > 0 ? 4 : 0, prior), ["--i" as string]: index }}
                />
                <div
                  className={`dl-bar w-[38%] max-w-4 rounded-t-sm ${column.partial ? "bar-partial" : "bg-bar"}`}
                  style={{ height: Math.max(column.spentCents > 0 ? 4 : 0, current), ["--i" as string]: index }}
                />
              </div>
              <p className="mt-2 text-center text-xs font-medium">{shortMonthLabel(column.year, column.month)}</p>
              <p className="text-center text-xs tabular-nums text-muted-foreground">{compactCents(column.spentCents)}</p>
              <p className={`text-center text-xs font-medium ${column.partialLabel ? "text-amber-800" : "invisible"}`}>so far</p>
            </div>
          );
        })}
      </div>
      <ChartRows title="Month by month" rows={historyRows(columns)} />
    </figure>
  );
}
