import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The empty-state pattern (PEN-204): say what is missing in plain words and
 * give one clear next action. `extra` is for a second, smaller option.
 */
export function NextStep({
  title,
  body,
  href,
  action,
  extra,
  className,
}: {
  title: string;
  body?: ReactNode;
  href?: string;
  action?: string;
  extra?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start gap-4 rounded-md border-2 border-dashed border-foreground bg-secondary/60 px-4 py-5", className)}>
      <span aria-hidden="true" className="mt-0.5 size-8 shrink-0 rounded-full border-2 border-dashed border-foreground bg-white" />
      <div className="min-w-0 flex-1">
      <p className="font-heading font-extrabold">{title}</p>
      {body ? <p className="mt-1 text-sm text-muted-foreground">{body}</p> : null}
      {href && action ? (
        <div className="mt-3 flex flex-wrap items-start gap-2">
          <Link href={href} className={cn(buttonVariants({ size: "sm" }))}>
            {action}
          </Link>
          {extra}
        </div>
      ) : extra ? (
        <div className="mt-3 flex flex-wrap items-start gap-2">{extra}</div>
      ) : null}
      </div>
    </div>
  );
}
