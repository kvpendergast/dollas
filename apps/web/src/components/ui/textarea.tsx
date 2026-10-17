import * as React from "react"
import { cn } from "@/lib/utils"

/** Textarea, styled like Input (2px input border, focus shadow, error tint on aria-invalid). */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-24 w-full min-w-0 rounded-sm border-2 border-input bg-white px-4 py-3 text-base font-medium text-foreground transition-[box-shadow,border-color] duration-(--motion-fast) ease-(--ease-out) outline-none placeholder:text-muted-foreground focus-visible:border-primary focus-visible:shadow-focus disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-70 aria-invalid:border-destructive aria-invalid:bg-error-tint",
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
