import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Slot } from "radix-ui"

const buttonVariants = cva(
  // Candy button (PEN-307). Hover/press shift only when motion is allowed; the bounce comes from --ease-bounce.
  "group/button inline-flex shrink-0 items-center justify-center rounded-full border-2 border-foreground font-heading font-extrabold whitespace-nowrap transition-[transform,box-shadow,background-color,color] duration-(--motion-base) ease-(--ease-bounce) outline-none select-none focus-visible:border-primary focus-visible:shadow-focus focus-visible:outline-3 focus-visible:outline-ring focus-visible:outline-offset-2 disabled:pointer-events-none disabled:border-muted-foreground disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-pop motion-safe:hover:-translate-x-0.5 motion-safe:hover:-translate-y-0.5 hover:shadow-hover motion-safe:active:translate-x-0.5 motion-safe:active:translate-y-0.5 active:shadow-press",
        outline:
          "bg-card text-foreground hover:bg-amber aria-expanded:bg-amber",
        secondary:
          "bg-transparent text-foreground hover:bg-amber aria-expanded:bg-amber",
        ghost:
          "border-transparent text-foreground hover:bg-secondary aria-expanded:bg-secondary",
        destructive:
          "border-destructive bg-transparent text-destructive hover:bg-error-tint focus-visible:border-destructive",
        link: "border-transparent text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-12 gap-2 px-5 text-base has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        xs: "h-9 gap-1 px-3 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "h-11 gap-1.5 px-4 text-sm [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-12 gap-2 px-6 text-base",
        icon: "size-11",
        "icon-xs": "size-9 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-11",
        "icon-lg": "size-12",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
