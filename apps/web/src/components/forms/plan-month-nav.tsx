"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function PlanMonthNav({
  monthKey,
  label,
  previousHref,
  nextHref,
}: {
  monthKey: string;
  label: string;
  previousHref: string | null;
  nextHref: string | null;
}) {
  const router = useRouter();
  return (
    <div className="flex flex-wrap items-center gap-2">
      {previousHref ? (
        <Button asChild variant="outline" size="sm">
          <Link href={previousHref} aria-label="Previous month">
            Previous
          </Link>
        </Button>
      ) : (
        <Button variant="outline" size="sm" disabled>
          Previous
        </Button>
      )}
      <form action="/plan" method="get" className="flex items-center gap-2">
        <label htmlFor="plan-month" className="sr-only">
          Month
        </label>
        <Input
          key={monthKey}
          id="plan-month"
          name="month"
          type="month"
          defaultValue={monthKey}
          aria-label={label}
          className="w-40"
          onChange={(event) => {
            if (/^\d{4}-\d{2}$/.test(event.target.value)) router.push(`/plan?month=${event.target.value}`);
          }}
        />
        <Button type="submit" size="sm" variant="secondary">
          Show
        </Button>
      </form>
      {nextHref ? (
        <Button asChild variant="outline" size="sm">
          <Link href={nextHref} aria-label="Next month">
            Next
          </Link>
        </Button>
      ) : (
        <Button variant="outline" size="sm" disabled>
          Next
        </Button>
      )}
    </div>
  );
}
