import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * PageHeader: the page's single h1 (the squiggle underline comes from globals.css) with an
 * optional description and a trailing slot (badge, actions). Use once per page, first in the page.
 */
export function PageHeader({
  title,
  description,
  badge,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-4xl tracking-tight">{title}</h1>
          {badge}
        </div>
        {description ? <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
