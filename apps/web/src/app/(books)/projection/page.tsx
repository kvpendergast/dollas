import { formatCents, monthLabel } from "@dollas/domain";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireBooks } from "@/slices/access/guard";
import { loadProjection } from "@/slices/books/queries";

export default async function ProjectionPage() {
  const books = await requireBooks();
  const estimate = await loadProjection(books);
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="font-serif text-4xl">A look ahead</h1>
        <p className="text-sm text-muted-foreground">{monthLabel(books.asOf.year, books.asOf.month)} is still open. This is a guess.</p>
      </div>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>The guess</CardTitle>
            <Badge>Guess</Badge>
          </div>
          <CardDescription>
            Daily pace times the days in the month. A guess, not a closed total, and not a phone tab.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="font-serif text-5xl tabular-nums">{formatCents(estimate.estimateCents)}</p>
          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-muted-foreground">Spent so far</dt>
              <dd className="font-serif text-xl tabular-nums">{formatCents(estimate.spentSoFarCents)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Daily pace</dt>
              <dd className="font-serif text-xl tabular-nums">{formatCents(estimate.dailyPaceCents)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Days elapsed</dt>
              <dd className="font-serif text-xl tabular-nums">
                {estimate.daysElapsed} of {estimate.daysInMonth}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Days remaining</dt>
              <dd className="font-serif text-xl tabular-nums">{estimate.daysRemaining}</dd>
            </div>
          </dl>
          <p className="text-sm text-muted-foreground">
            {formatCents(estimate.spentSoFarCents)} / {estimate.daysElapsed} days × {estimate.daysInMonth} days.
          </p>
          <Link href="/" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
            Back to this month
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}
