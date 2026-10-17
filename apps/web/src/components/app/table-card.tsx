"use client";

import { useState, type ReactNode } from "react";
import { Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * TableCard: a wide table in a titled card with an "Expand table to full screen" button at the
 * top right of the header. Reusable: pass `title`, optional `controls` (toggles, switches), and a
 * render function for the table that receives `{ fullscreen }`.
 *
 * Full screen is a shadcn Dialog (Escape and the visible Close button exit, focus is trapped and
 * returned to the button). The table body is mounted once: inline, or in the dialog while it is
 * open, so any state the caller keeps (period, switches) simply carries over. `controls` move into
 * the dialog with it, so they stay usable. When `fullscreen` is true the table should keep its
 * header row and first column sticky and fill the height (`h-full overflow-auto`).
 */
export function TableCard({
  title,
  controls,
  children,
  className,
}: {
  title: string;
  controls?: ReactNode;
  children: (state: { fullscreen: boolean }) => ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <div className={cn("space-y-4", className)}>
        {!open && controls ? controls : null}
        <section aria-label={title} className="overflow-hidden rounded-md border-2 border-foreground bg-card shadow-soft">
          <div className="flex min-h-14 items-center justify-between gap-3 border-b-2 border-foreground px-3 py-1.5">
            <h2 className="font-heading text-lg font-extrabold">{title}</h2>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" aria-label="Expand table to full screen">
                <Maximize2 aria-hidden="true" />
                <span className="hidden sm:inline">Full screen</span>
              </Button>
            </DialogTrigger>
          </div>
          {open ? <p className="px-3 py-4 text-sm text-muted-foreground">This table is open full screen.</p> : children({ fullscreen: false })}
        </section>
      </div>
      <DialogContent fullscreen aria-describedby="table-card-description">
        <div className="flex min-h-14 shrink-0 items-center border-b-2 border-foreground py-1.5 pr-16 pl-4">
          <DialogTitle className="truncate">{title}</DialogTitle>
          <DialogDescription id="table-card-description" className="sr-only">
            Full screen table. Press Escape or choose Close to go back.
          </DialogDescription>
        </div>
        {controls ? <div className="shrink-0 border-b-2 border-border-soft px-4 py-2">{controls}</div> : null}
        <div className="relative min-h-0 flex-1">{open ? children({ fullscreen: true }) : null}</div>
      </DialogContent>
    </Dialog>
  );
}
