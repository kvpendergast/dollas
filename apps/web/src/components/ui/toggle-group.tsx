"use client"

import * as React from "react"
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui"
import { cn } from "@/lib/utils"

/**
 * Toggle Group (type="single") for a small set of exclusive options, shown as a
 * segmented pill. Radix allows deselecting the active item; use
 * <ChoiceGroup> below when one option must always stay selected.
 */
function ToggleGroup({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn("inline-flex w-full flex-wrap gap-1 rounded-[1.5rem] border-2 border-foreground bg-card p-1 sm:w-auto sm:flex-nowrap sm:rounded-full", className)}
      {...props}
    />
  )
}

function ToggleGroupItem({ className, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        "inline-flex min-h-11 flex-1 items-center justify-center rounded-full px-4 text-center font-heading text-sm leading-tight font-extrabold text-foreground transition-[background-color,color,box-shadow] duration-(--motion-base) ease-(--ease-out) outline-none hover:bg-secondary focus-visible:shadow-focus focus-visible:outline-3 focus-visible:outline-ring data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:shadow-press",
        className,
      )}
      {...props}
    />
  )
}

/** Single-select Toggle Group that ignores the "deselect" click, so a value is always chosen. */
function ChoiceGroup({
  value,
  onValueChange,
  ...props
}: Omit<React.ComponentProps<typeof ToggleGroupPrimitive.Root>, "type" | "value" | "onValueChange" | "defaultValue"> & {
  value: string
  onValueChange: (value: string) => void
}) {
  return <ToggleGroup type="single" value={value} onValueChange={(next) => next && onValueChange(next)} {...props} />
}

export { ToggleGroup, ToggleGroupItem, ChoiceGroup }
