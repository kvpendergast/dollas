import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Alert (shadcn): an inline callout. variant "default" is a note, "destructive" is an error.
 * Pass role="alert" for errors that appear after an action, role="status" for polite updates.
 */
const alertVariants = cva("relative grid gap-1 rounded-md border-2 p-3 text-sm", {
  variants: {
    variant: {
      default: "border-border bg-secondary text-foreground",
      destructive: "border-over bg-error-tint text-over",
      warning: "border-border bg-amber/40 text-foreground",
    },
  },
  defaultVariants: { variant: "default" },
});

function Alert({ className, variant, ...props }: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-title" className={cn("font-heading font-extrabold", className)} {...props} />;
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-description" className={cn("text-sm font-medium", className)} {...props} />;
}

export { Alert, AlertDescription, AlertTitle, alertVariants };
