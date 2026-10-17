import * as React from "react"
import { cn } from "@/lib/utils"
import { Label } from "@/components/ui/label"

/**
 * Form field wrapper: Field (spacing) + FieldLabel + control + FieldDescription + FieldError.
 * Link them yourself with htmlFor and aria-describedby, e.g.
 *   <Field><FieldLabel htmlFor="x">Name</FieldLabel><Input id="x" aria-describedby="x-help" /><FieldDescription id="x-help">…</FieldDescription></Field>
 */
function Field({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="field" className={cn("space-y-1.5", className)} {...props} />
}

const FieldLabel = Label

function FieldDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="field-description" className={cn("text-sm text-muted-foreground", className)} {...props} />
}

function FieldError({ className, children, ...props }: React.ComponentProps<"p">) {
  if (!children) return null
  return (
    <p data-slot="field-error" role="alert" className={cn("text-sm font-bold text-destructive", className)} {...props}>
      {children}
    </p>
  )
}

export { Field, FieldLabel, FieldDescription, FieldError }
