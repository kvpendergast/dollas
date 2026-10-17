import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * GroupCard: a titled card with a header band (title, description, actions) and a body list.
 * tone "default" is the sage band for real groups, "muted" for the Ungrouped bucket.
 * Put CategoryPill rows inside as children (an <ol> of <li>).
 */
export function GroupCard({
  title,
  description,
  actions,
  tone = "default",
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  tone?: "default" | "muted";
  children?: ReactNode;
}) {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className={cn("border-b-2 border-foreground py-3", tone === "muted" ? "bg-muted" : "bg-secondary")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h2 className="font-heading text-2xl leading-none">{title}</h2>
            {description ? <CardDescription className="mt-1">{description}</CardDescription> : null}
          </div>
          {actions}
        </div>
      </CardHeader>
      {children ? <CardContent className="py-2">{children}</CardContent> : null}
    </Card>
  );
}

/** CategoryPill: a category's name as a rounded pill. Pair with a kind tag and an edit action in a row. */
export function CategoryPill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("rounded-full border-2 border-foreground bg-white px-3 py-1 font-bold break-words", className)}>{children}</span>
  );
}
