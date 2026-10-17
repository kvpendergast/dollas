import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * PlanMeter: the rounded progress bar used for budgets, spending shares and setup progress.
 * `percent` is 0-100. tone "over" fills red (never rely on colour alone: pair it with an
 * "over" label, see MoneyAmount). Pass `label` to expose it as a progressbar; omit it when the
 * numbers beside it already say everything (then it is hidden from screen readers).
 */
const fillVariants = cva("h-full rounded-full", {
  variants: { tone: { default: "bg-bar", primary: "bg-primary", over: "bg-over" } },
  defaultVariants: { tone: "default" },
});

export function PlanMeter({
  percent,
  tone,
  label,
  valueNow,
  valueMax,
  animate = false,
  className,
}: {
  percent: number;
  label?: string;
  valueNow?: number;
  valueMax?: number;
  animate?: boolean;
  className?: string;
} & VariantProps<typeof fillVariants>) {
  const clamped = Math.max(0, Math.min(100, percent));
  const a11y = label
    ? { role: "progressbar" as const, "aria-label": label, "aria-valuemin": 0, "aria-valuemax": valueMax ?? 100, "aria-valuenow": valueNow ?? Math.round(clamped) }
    : { "aria-hidden": true as const };
  return (
    <div data-slot="plan-meter" className={cn("h-3.5 overflow-hidden rounded-full border-2 border-foreground bg-white", className)} {...a11y}>
      {animate ? (
        <div className={cn(fillVariants({ tone }), "dl-transition w-full origin-left")} style={{ transform: `scaleX(${clamped / 100})` }} />
      ) : (
        <div className={fillVariants({ tone })} style={{ width: `${clamped}%` }} />
      )}
    </div>
  );
}
