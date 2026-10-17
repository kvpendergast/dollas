import { cn } from "@/lib/utils";

/** Skeleton (shadcn): a pulsing placeholder block. Size it with className. Pulse stops under reduced motion. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("animate-pulse rounded-md bg-secondary motion-reduce:animate-none", className)}
      {...props}
    />
  );
}

export { Skeleton };
