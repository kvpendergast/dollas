"use client"

import * as React from "react"
import { Tabs as TabsPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

/**
 * Segmented tabs (PEN-307). Radix gives role=tablist/tab/tabpanel, roving
 * focus with the arrow keys, and renders only the selected panel.
 */
function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col gap-4", className)} {...props} />
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn("inline-flex max-w-full items-center gap-1 self-start rounded-full border-2 border-foreground bg-card p-1", className)}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 font-heading text-sm font-extrabold whitespace-nowrap text-foreground transition-[background-color,color,box-shadow] duration-(--motion-base) ease-(--ease-out) outline-none hover:bg-secondary focus-visible:shadow-focus focus-visible:outline-3 focus-visible:outline-ring data-[state=active]:bg-primary data-[state=active]:text-primary-foreground data-[state=active]:shadow-press",
        className,
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("outline-none", className)} {...props} />
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
