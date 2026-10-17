"use client"

import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

/** A toggle (PEN-310). Radix gives role=switch, Space/Enter, and aria-checked. 44px tall hit area via the wrapper label. */
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer relative inline-flex h-[30px] w-[52px] shrink-0 items-center rounded-full border-2 border-foreground bg-muted transition-[background-color] duration-(--motion-base) ease-(--ease-out) outline-none focus-visible:shadow-focus focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60 data-[state=checked]:bg-primary",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-[22px] translate-x-0.5 rounded-full border-2 border-foreground bg-white transition-transform duration-(--motion-base) ease-(--ease-bounce) data-[state=checked]:translate-x-[22px]"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
