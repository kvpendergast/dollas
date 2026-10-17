import { shortMonthLabel, type HistoryColumn } from "@dollas/domain";
import { ColumnChart } from "@/components/app/column-chart";
import { ChartLegend, ChartRows } from "@/components/charts/chart-rows";
import { compactCents, historyRows, historySummary } from "@/components/charts/chart-text";

/**
 * History (PEN-208 layout). Vertical columns, prior year beside this
 * year, the current partial month hatched amber "so far". Columns are
 * fluid: a phone shows the latest six months, wider screens all twelve, with no
 * fixed min width and no labels under 12px. Deltas read as text with a sign
 * and the month they compare with in the list under the bars; the bars are
 * decorative for screen readers, which get a summary and the list.
 */
const PHONE_COLUMNS = 6;
const BAR_HEIGHT = 144;

export function HistoryChart({ columns }: { columns: HistoryColumn[] }) {
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
      <ColumnChart
        name="history"
        height={BAR_HEIGHT}
        phoneCount={PHONE_COLUMNS}
        items={columns.map((column) => ({
          key: `${column.year}-${column.month}`,
          label: shortMonthLabel(column.year, column.month),
          valueLabel: compactCents(column.spentCents),
          flag: Boolean(column.partialLabel),
          bars: [
            { cents: column.priorYearSpentCents, tone: "prior" },
            { cents: column.spentCents, tone: "current", partial: column.partial },
          ],
        }))}
      />
      <ChartRows title="Month by month" rows={historyRows(columns)} />
    </figure>
  );
}
