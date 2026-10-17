import type { ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * StatCard: a label with one big number (tabular figures). tone colours the number:
 * "income" green, "over" red, "default" ink. size "lg" is for two-up summaries.
 * `note` is small supporting text under the number.
 */
const statValueVariants = cva("font-heading font-extrabold break-words tabular-nums", {
  variants: {
    tone: { default: "", income: "text-income", over: "text-over" },
    size: { sm: "text-xl min-[400px]:text-2xl sm:text-3xl", lg: "text-3xl" },
  },
  defaultVariants: { tone: "default", size: "sm" },
});

export function StatCard({
  label,
  value,
  note,
  tone,
  size,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  className?: string;
} & VariantProps<typeof statValueVariants>) {
  return (
    <Card size={size === "lg" ? "default" : "sm"} className={className}>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className={cn(statValueVariants({ tone, size }))}>{value}</CardTitle>
      </CardHeader>
      {note ? (
        <CardContent>
          <div className="text-xs text-muted-foreground">{note}</div>
        </CardContent>
      ) : null}
    </Card>
  );
}
