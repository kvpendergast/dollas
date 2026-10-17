"use client";

import * as React from "react";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * Collapsible (shadcn): a show/hide section. The content stays mounted while closed
 * (hidden), so form fields inside a closed section still post with their form.
 * CollapsibleTrigger is a real button (aria-expanded) at least 44px tall.
 */
function Collapsible(props: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

function CollapsibleTrigger({ className, ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Trigger>) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      className={cn(
        "flex min-h-11 w-full cursor-pointer items-center justify-between gap-2 text-left text-sm font-medium focus-visible:shadow-focus focus-visible:outline-3 focus-visible:outline-ring",
        className,
      )}
      {...props}
    />
  );
}

function CollapsibleContent({ className, ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Content>) {
  return <CollapsiblePrimitive.Content data-slot="collapsible-content" forceMount className={cn("dl-sheet", className)} {...props} />;
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger };
