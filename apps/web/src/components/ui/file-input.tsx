"use client";

import * as React from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * FileInput (shadcn style): a Button-looking trigger plus the chosen filename. The real
 * <input type="file"> stays in the DOM (visually hidden, still focusable) so name, required,
 * accept and form posts behave natively. Label it with a <Label htmlFor={id}>.
 */
function FileInput({ className, id, onChange, children = "Choose file", ...props }: Omit<React.ComponentProps<"input">, "type"> & { children?: React.ReactNode }) {
  const [name, setName] = React.useState("");
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    const reset = () => setName("");
    form.addEventListener("reset", reset);
    return () => form.removeEventListener("reset", reset);
  }, []);
  return (
    <div data-slot="file-input" className={cn("relative flex min-h-12 items-center gap-3", className)}>
      <input
        ref={ref}
        id={id}
        type="file"
        className="peer absolute inset-0 size-full cursor-pointer opacity-0"
        onChange={(event) => {
          setName(event.target.files?.[0]?.name ?? "");
          onChange?.(event);
        }}
        {...props}
      />
      <span
        aria-hidden="true"
        className={cn(buttonVariants({ variant: "outline" }), "pointer-events-none shrink-0 peer-focus-visible:shadow-focus peer-focus-visible:outline-3 peer-focus-visible:outline-ring")}
      >
        {children}
      </span>
      <span className="min-w-0 truncate text-sm text-muted-foreground" aria-live="polite">
        {name || "No file chosen"}
      </span>
    </div>
  );
}

export { FileInput };
