import { Badge } from "@/components/ui/badge";

/**
 * StatusPill: the one pill for state words. Recurring months (paid, received, due, missed,
 * upcoming, not this month, paused) and import rows (ready, error). The label always says
 * the state in words, colour only supports it.
 */
export type Status = "paid" | "received" | "expected" | "missed" | "upcoming" | "none" | "paused" | "ready" | "error";

const COPY: Record<Status, { label: string; className?: string; variant?: "outline" | "ready" | "destructive" }> = {
  paid: { label: "Paid", className: "border-transparent bg-primary/10 text-primary" },
  received: { label: "Received", className: "border-transparent bg-income/10 text-income" },
  expected: { label: "Due", className: "border-primary/40 text-foreground" },
  missed: { label: "Missed", className: "border-transparent bg-over/10 text-over" },
  upcoming: { label: "Upcoming", className: "border-border text-muted-foreground" },
  none: { label: "Not this month", className: "border-border text-muted-foreground" },
  paused: { label: "Paused", className: "border-border text-muted-foreground" },
  ready: { label: "Ready", variant: "ready" },
  error: { label: "Error", variant: "destructive" },
};

export function statusLabel(status: Status): string {
  return COPY[status].label;
}

export function StatusPill({ status }: { status: Status }) {
  const copy = COPY[status];
  return (
    <Badge variant={copy.variant ?? "outline"} className={copy.className}>
      {copy.label}
    </Badge>
  );
}
