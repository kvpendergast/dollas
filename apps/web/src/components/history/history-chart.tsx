import { formatCents, shortMonthLabel, type HistoryColumn } from "@dollas/domain";

function tone(direction: "less" | "more" | "same"): string {
  if (direction === "less") return "text-income";
  if (direction === "more") return "text-over";
  return "text-muted-foreground";
}

function changeCopy(direction: "less" | "more" | "same", deltaCents: number, comparedWith: string): string {
  if (direction === "same") return `Same ${comparedWith}`;
  const word = direction === "less" ? "less" : "more";
  return `${formatCents(Math.abs(deltaCents))} ${word} ${comparedWith}`;
}

export function HistoryChart({ columns }: { columns: HistoryColumn[] }) {
  const max = Math.max(1, ...columns.flatMap((column) => [column.spentCents, column.priorYearSpentCents]));
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-sm bg-prior" />
          Prior year
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-sm bg-bar" />
          This year
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="bar-partial inline-block h-3 w-3 rounded-sm" />
          So far
        </span>
      </div>
      <div className="overflow-x-auto pb-2">
        <div className="flex min-w-[760px] items-end gap-3" role="list" aria-label="Spending by month">
          {columns.map((column) => {
            const currentHeight = Math.round((column.spentCents / max) * 148);
            const priorHeight = Math.round((column.priorYearSpentCents / max) * 148);
            return (
              <div key={`${column.year}-${column.month}`} role="listitem" className="w-[72px] shrink-0">
                <div className="flex h-40 items-end justify-center gap-1">
                  <div
                    className="w-4 rounded-t-sm bg-prior"
                    style={{ height: Math.max(column.priorYearSpentCents > 0 ? 4 : 0, priorHeight) }}
                    title={`Prior year ${formatCents(column.priorYearSpentCents)}`}
                  />
                  <div
                    className={column.partial ? "bar-partial w-4 rounded-t-sm" : "w-4 rounded-t-sm bg-bar"}
                    style={{ height: Math.max(column.spentCents > 0 ? 4 : 0, currentHeight) }}
                    title={column.partial ? `So far ${formatCents(column.spentCents)}` : formatCents(column.spentCents)}
                  />
                </div>
                <p className="mt-2 text-center text-xs font-medium">
                  {shortMonthLabel(column.year, column.month)}
                </p>
                <p className="text-center font-serif text-sm tabular-nums">{formatCents(column.spentCents)}</p>
                {column.partialLabel ? (
                  <p className="text-center text-[11px] font-medium text-amber-800">so far</p>
                ) : (
                  <p className="text-center text-[11px] text-transparent" aria-hidden="true">
                    so far
                  </p>
                )}
                <p className={`mt-2 text-center text-[11px] leading-tight ${tone(column.monthOverMonth.direction)}`}>
                  {changeCopy(
                    column.monthOverMonth.direction,
                    column.monthOverMonth.deltaCents,
                    column.partial ? "than last month, same days" : "than last month",
                  )}
                </p>
                {column.yearOverYear.comparable ? (
                  <p className={`text-center text-[11px] leading-tight ${tone(column.yearOverYear.direction)}`}>
                    {changeCopy(column.yearOverYear.direction, column.yearOverYear.deltaCents, "than last year")}
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
