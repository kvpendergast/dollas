import { Badge } from "@/components/ui/badge";

/**
 * StatusPill: the one pill for state words. Recurring months (paid, received, due, missed,
 * upcoming, not this month, paused) and import rows (ready, error). The label always says
 * the state in words, colour only supports it.
 */
export type Status = "paid" | "received" | "expected" | "missed" | "upcoming" | "none" | "paused" | "ready" | "error" | "sofar";

const COPY: Record<Status, { label: string; className?: string; variant?: "outline" | "ready" | "destructive" | "mtd" }> = {
  paid: { label: "Paid", className: "border-transparent bg-primary/10 text-primary" },
  received: { label: "Received", className: "border-transparent bg-income/10 text-income" },
  expected: { label: "Due", className: "border-primary/40 text-foreground" },
  missed: { label: "Missed", className: "border-transparent bg-over/10 text-over" },
  upcoming: { label: "Upcoming", className: "border-border text-muted-foreground" },
  none: { label: "Not this month", className: "border-border text-muted-foreground" },
  paused: { label: "Paused", className: "border-border text-muted-foreground" },
  ready: { label: "Ready", variant: "ready" },
  error: { label: "Error", variant: "destructive" },
  sofar: { label: "So far", variant: "mtd" },
};

export function statusLabel(status: Status): string {
  return COPY[status].label;
}

/** `label` swaps the words (for example "Includes Oct so far"); the state and style stay. */
export function StatusPill({ status, label }: { status: Status; label?: string }) {
  const copy = COPY[status];
  return (
    <Badge variant={copy.variant ?? "outline"} className={copy.className}>
      {label ?? copy.label}
    </Badge>
  );
}
