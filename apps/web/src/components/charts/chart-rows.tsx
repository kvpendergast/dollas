import type { ChartRow, Tone } from "./chart-text";

export function toneClass(tone: Tone): string {
  if (tone === "less") return "text-income";
  if (tone === "more") return "text-over";
  return "text-muted-foreground";
}

function Row({ row }: { row: ChartRow }) {
  return (
    <li className="grid gap-1 py-3 sm:grid-cols-[8rem_7rem_1fr] sm:items-baseline sm:gap-4">
      <p className="flex items-baseline justify-between gap-2 text-sm font-medium sm:block">
        <span>{row.label}</span>
        <span className="font-serif tabular-nums sm:hidden">
          {row.amount}
          {row.partial ? <span className="ml-1 text-xs font-medium text-amber-800">so far</span> : null}
        </span>
      </p>
      <p className="hidden font-serif text-sm tabular-nums sm:block">
        {row.amount}
        {row.partial ? <span className="ml-1 font-sans text-xs font-medium text-amber-800">so far</span> : null}
      </p>
      <div className="space-y-0.5 text-sm leading-snug">
        {row.lines.map((line) => (
          <p key={line.text} className={toneClass(line.tone)}>
            {line.text}
          </p>
        ))}
      </div>
    </li>
  );
}

/**
 * The chart's numbers as text, newest first: the accessible version of the
 * bars, and where the deltas read in words. The first `visible` rows show;
 * the rest fold under a disclosure so a phone page stays short.
 */
export function ChartRows({ title, rows, visible = 6 }: { title: string; rows: ChartRow[]; visible?: number }) {
  const shown = rows.slice(0, visible);
  const rest = rows.slice(visible);
  return (
    <div className="mt-6 border-t border-border pt-2">
      <h3 className="pt-2 text-sm font-medium text-muted-foreground">{title}</h3>
      <ol className="divide-y divide-border">
        {shown.map((row) => (
          <Row key={row.key} row={row} />
        ))}
      </ol>
      {rest.length > 0 ? (
        <details className="group">
          <summary className="flex cursor-pointer list-none items-center py-2 text-sm text-primary underline-offset-4 hover:underline [&::-webkit-details-marker]:hidden">
            <span className="group-open:hidden">Show {rest.length} earlier</span>
            <span className="hidden group-open:inline">Hide earlier</span>
          </summary>
          <ol className="dl-sheet divide-y divide-border">
            {rest.map((row) => (
              <Row key={row.key} row={row} />
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}

export function ChartLegend({ items }: { items: Array<{ label: string; swatch: string }> }) {
  return (
    <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <span key={item.label} className="inline-flex items-center gap-2">
          <span className={`inline-block h-3 w-3 rounded-sm ${item.swatch}`} aria-hidden="true" />
          {item.label}
        </span>
      ))}
    </div>
  );
}
