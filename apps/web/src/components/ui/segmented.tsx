"use client"

import * as React from "react"
import { RadioGroup as RadioGroupPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

/**
 * Segmented choice (PEN-310) for a small set of mutually exclusive options.
 * A radio group underneath: one tab stop, arrow keys move, label via aria-labelledby.
 */
function Segmented({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="segmented"
      className={cn("inline-flex w-full flex-wrap gap-1 rounded-[1.5rem] border-2 border-foreground bg-card p-1 sm:w-auto sm:flex-nowrap sm:rounded-full", className)}
      {...props}
    />
  )
}

function SegmentedOption({ className, children, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="segmented-option"
      className={cn(
        "inline-flex min-h-11 flex-1 items-center justify-center rounded-full px-4 text-center font-heading text-sm leading-tight font-extrabold text-foreground transition-[background-color,color,box-shadow] duration-(--motion-base) ease-(--ease-out) outline-none hover:bg-secondary focus-visible:shadow-focus focus-visible:outline-3 focus-visible:outline-ring data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=checked]:shadow-press",
        className,
      )}
      {...props}
    >
      {children}
    </RadioGroupPrimitive.Item>
  )
}

export { Segmented, SegmentedOption }
