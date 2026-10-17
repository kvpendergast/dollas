"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Separator as SeparatorPrimitive } from "radix-ui"

function Separator({
  className,
  orientation = "horizontal",
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        "shrink-0 border-border-soft data-horizontal:w-full data-horizontal:border-t-2 data-horizontal:border-dashed data-vertical:self-stretch data-vertical:border-l-2 data-vertical:border-dashed",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
