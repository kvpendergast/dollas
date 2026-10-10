import { Badge } from "@/components/ui/badge";

type Status = "paid" | "received" | "expected" | "missed" | "upcoming" | "none" | "paused";

const COPY: Record<Status, { label: string; className: string }> = {
  paid: { label: "Paid", className: "border-transparent bg-primary/10 text-primary" },
  received: { label: "Received", className: "border-transparent bg-income/10 text-income" },
  expected: { label: "Due", className: "border-primary/40 text-foreground" },
  missed: { label: "Missed", className: "border-transparent bg-over/10 text-over" },
  upcoming: { label: "Upcoming", className: "border-border text-muted-foreground" },
  none: { label: "Not this month", className: "border-border text-muted-foreground" },
  paused: { label: "Paused", className: "border-border text-muted-foreground" },
};

export function statusLabel(status: Status): string {
  return COPY[status].label;
}

export function RecurringStatusBadge({ status }: { status: Status }) {
  const copy = COPY[status];
  return (
    <Badge variant="outline" className={copy.className}>
      {copy.label}
    </Badge>
  );
}
