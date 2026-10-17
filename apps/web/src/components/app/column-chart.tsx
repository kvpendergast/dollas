import { cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * ColumnChart: the one vertical column chart (History and the Spending trend). It is decorative
 * for screen readers (aria-hidden): the caller supplies a figcaption summary and a text list
 * (ChartRows) carrying every number and delta. Each column has a label, a value line, up to two
 * bars (prior year beside this year) and an optional "so far" flag for the current partial period.
 * A phone shows the last `phoneCount` columns, wider screens all of them. Heights scale to the
 * largest bar. `data-chart` carries `name` for tests.
 */
export type ColumnBar = { cents: number; tone: "prior" | "current"; partial?: boolean };
export type ColumnItem = { key: string; label: string; valueLabel: string; flag?: boolean; bars: ColumnBar[] };

const barVariants = cva("dl-bar rounded-t-sm border-2 border-b-0 border-foreground", {
  variants: {
    tone: { prior: "bg-prior", current: "bg-bar" },
    partial: { true: "bar-partial border-dashed", false: "" },
    width: { narrow: "w-[38%] max-w-4", wide: "w-[55%] max-w-6" },
  },
  defaultVariants: { partial: false },
});

export function ColumnChart({
  name,
  items,
  height,
  phoneCount,
  className,
}: {
  name: string;
  items: ColumnItem[];
  height: number;
  phoneCount: number;
  className?: string;
}) {
  const max = Math.max(1, ...items.flatMap((item) => item.bars.map((bar) => bar.cents)));
  const phoneFrom = Math.max(0, items.length - phoneCount);
  return (
    <div aria-hidden="true" data-chart={name} className={cn("grid auto-cols-fr grid-flow-col items-end gap-1.5 sm:gap-2", className)}>
      {items.map((item, index) => (
        <div key={item.key} className={cn("min-w-0", index < phoneFrom && "hidden sm:block")}>
          <div className="flex items-end justify-center gap-[3px] border-b-2 border-foreground" style={{ height: height + 4 }}>
            {item.bars.map((bar, barIndex) => (
              <div
                key={barIndex}
                className={barVariants({ tone: bar.tone, partial: Boolean(bar.partial), width: item.bars.length > 1 ? "narrow" : "wide" })}
                style={{ height: Math.max(bar.cents > 0 ? 4 : 0, Math.round((bar.cents / max) * height)), ["--i" as string]: index }}
              />
            ))}
          </div>
          <p className="mt-2 text-center text-xs leading-tight font-medium">{item.label}</p>
          <p className="text-center text-xs tabular-nums text-muted-foreground">{item.valueLabel}</p>
          <p className={cn("text-center text-xs font-medium", item.flag ? "text-amber-800" : "invisible")}>so far</p>
        </div>
      ))}
    </div>
  );
}
