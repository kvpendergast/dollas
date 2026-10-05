import { formatCents, monthLabel } from "@dollas/domain";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Landing } from "@/components/landing";
import { getActorContext, requireBooks } from "@/slices/access/guard";
import { loadHome } from "@/slices/books/queries";

export default async function HomePage() {
  const ctx = await getActorContext();
  if (!ctx) return <Landing />;
  const books = await requireBooks();
  const home = await loadHome(books);
  const leftTone = home.leftCents < 0 ? "text-over" : "text-income";
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-4xl tracking-tight">{monthLabel(books.asOf.year, books.asOf.month)}</h1>
        <p className="text-sm text-muted-foreground">This month is still open. Numbers run through today.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>Income</CardDescription>
            <CardTitle className="font-serif text-3xl text-income tabular-nums">{formatCents(home.incomeCents)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Spent</CardDescription>
            <CardTitle className="font-serif text-3xl tabular-nums">{formatCents(home.spentCents)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Money left</CardDescription>
            <CardTitle className={`font-serif text-3xl tabular-nums ${leftTone}`}>{formatCents(home.leftCents)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>In accounts</CardDescription>
            <CardTitle
              className={`font-serif text-3xl tabular-nums ${home.accountBalanceCents < 0 ? "text-over" : "text-income"}`}
            >
              {formatCents(home.accountBalanceCents)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">Active accounts only. Archived accounts are left out.</p>
          </CardContent>
        </Card>
      </div>
      <Card className="border-primary/20">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>Spend estimate</CardTitle>
            <Badge>Estimate</Badge>
          </div>
          <CardDescription>Labeled as an estimate. The month is not finished.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="font-serif text-5xl tabular-nums">{formatCents(home.estimate.estimateCents)}</p>
          <p className="text-sm text-muted-foreground">
            {formatCents(home.estimate.spentSoFarCents)} spent across {home.estimate.daysElapsed} of {home.estimate.daysInMonth} days.
          </p>
          <Link href="/projection" className="inline-flex text-sm font-medium text-primary underline-offset-4 hover:underline">
            See the estimate
          </Link>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>The plan so far</CardTitle>
          <CardDescription>{formatCents(home.budgetedCents)} budgeted this month.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {home.categories.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {home.hasAccounts ? "Nothing spent yet this month." : "No dollas in here yet. Add an account."}
            </p>
          ) : null}
          {home.categories.map((category) => (
            <div key={category.categoryId} className="flex items-baseline justify-between gap-3 text-sm">
              <span>{category.name}</span>
              <span className={category.standing === "over" ? "text-over tabular-nums" : "tabular-nums"}>
                {formatCents(category.spentCents)}
                {category.standing === "over" ? " · over budget" : ""}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
