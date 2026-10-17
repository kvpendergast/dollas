import { TriangleAlert } from "lucide-react";
import { formatCents } from "@dollas/domain";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * MoneyAmount: one place for how money looks (tabular figures so columns line up).
 * Pass `format` when a household currency formatter is available. tone "income" is green,
 * "over" red. With `over` set, an icon and the word "over" are added so the state is never
 * colour-only.
 */
const amountVariants = cva("tabular-nums", {
  variants: { tone: { default: "", income: "text-income", over: "text-over", muted: "text-muted-foreground" } },
  defaultVariants: { tone: "default" },
});

export function MoneyAmount({
  cents,
  format = formatCents,
  over = false,
  tone,
  className,
}: {
  cents: number;
  format?: (cents: number) => string;
  over?: boolean;
  className?: string;
} & VariantProps<typeof amountVariants>) {
  return (
    <span className={cn(amountVariants({ tone: over ? "over" : tone }), className)}>
      {format(cents)}
      {over ? (
        <>
          {" · "}
          <TriangleAlert aria-hidden="true" className="inline size-3.5 align-[-2px]" /> over
        </>
      ) : null}
    </span>
  );
}
