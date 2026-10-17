import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

const badgeVariants = cva(
  "group/badge inline-flex min-h-[26px] w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-full border-2 border-foreground px-2.5 py-0.5 font-heading text-xs leading-none font-extrabold tracking-wider whitespace-nowrap uppercase transition-colors focus-visible:shadow-focus focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-2 [&>svg]:pointer-events-none [&>svg]:size-3.5!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "bg-card text-foreground",
        destructive: "border-destructive bg-card text-destructive",
        outline: "bg-card text-foreground [a]:hover:bg-amber",
        ghost: "border-transparent hover:bg-secondary",
        link: "border-transparent text-primary underline-offset-4 hover:underline",
        // Status badges. Ink text on decorative fills; red stays the only "bad" signal.
        estimate: "bg-amber text-foreground",
        ready: "bg-mint text-foreground",
        over: "border-destructive bg-card text-destructive",
        mtd: "bar-partial text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
