import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * A styled native <select> (PEN-307): the browser's own picker keeps phones and
 * screen readers working. `selectClass` is for the few places that need the
 * classes on a plain element.
 */
export const selectClass =
  "h-12 w-full min-w-0 rounded-sm border-2 border-input bg-white px-3 text-base font-medium text-foreground transition-[box-shadow,border-color] duration-(--motion-fast) ease-(--ease-out) outline-none focus-visible:border-primary focus-visible:shadow-focus disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-70 aria-invalid:border-destructive aria-invalid:bg-error-tint"

function Select({ className, ...props }: React.ComponentProps<"select">) {
  return <select data-slot="select" className={cn(selectClass, className)} {...props} />
}

export { Select }
