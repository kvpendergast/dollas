import { formatCents, monthLabel, type CategoryMonth, type PlanSoFar } from "@dollas/domain";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Landing } from "@/components/landing";
import { getActorContext, requireBooks } from "@/slices/access/guard";
import { loadHome } from "@/slices/books/queries";

function estimateParts(
  estimate: { spentSoFarCents: number; recurringExpectedCents: number; paceCents: number },
  money: (cents: number) => string,
): string {
  const parts = [`${money(estimate.spentSoFarCents)} spent so far`];
  if (estimate.recurringExpectedCents > 0) parts.push(`${money(estimate.recurringExpectedCents)} in recurring bills still due`);
  if (estimate.paceCents > 0) parts.push(`${money(estimate.paceCents)} of everyday spending ahead`);
  return `${parts.join(" + ")}.`;
}

function PlanRow({ row, money }: { row: CategoryMonth; money: (cents: number) => string }) {
  const over = row.standing === "over";
  const budget = row.budgetCents;
  const share = budget && budget > 0 ? Math.min(100, Math.round((row.spentCents / budget) * 100)) : 0;
  return (
    <li className="space-y-1">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate">{row.name}</span>
        <span className={`shrink-0 tabular-nums ${over ? "text-over" : ""}`}>
          {budget == null ? money(row.spentCents) : `${money(row.spentCents)} of ${money(budget)}`}
          {over ? " · over" : ""}
        </span>
      </div>
      {budget != null ? (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <div className={`h-full rounded-full ${over ? "bg-over" : "bg-primary"}`} style={{ width: `${over ? 100 : share}%` }} />
        </div>
      ) : null}
    </li>
  );
}

function PlanSoFarCard({ plan, hasAccounts, money }: { plan: PlanSoFar; hasAccounts: boolean; money: (cents: number) => string }) {
  if (!plan.hasBudget) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Spending so far</CardTitle>
          <CardDescription>
            No budget this month.{" "}
            <Link href="/plan" className="font-medium text-primary underline-offset-4 hover:underline">
              Set one on Plan
            </Link>{" "}
            to see spent against budget.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {plan.unbudgeted.length === 0 ? (
            <p className="text-sm text-muted-foreground">{hasAccounts ? "Nothing spent yet this month." : "No dollas in here yet. Add an account."}</p>
          ) : (
            <ul className="space-y-3">
              {plan.unbudgeted.map((row) => (
                <PlanRow key={row.categoryId} row={row} money={money} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    );
  }
  const over = plan.spentInPlanCents > plan.budgetedCents;
  return (
    <Card>
      <CardHeader>
        <CardTitle>The plan so far</CardTitle>
        <CardDescription className={over ? "text-over" : undefined}>
          {money(plan.spentInPlanCents)} of {money(plan.budgetedCents)} budgeted spent this month.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <ul className="space-y-3">
          {plan.budgeted.map((row) => (
            <PlanRow key={row.categoryId} row={row} money={money} />
          ))}
        </ul>
        {plan.unbudgeted.length > 0 ? (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Not in the plan</p>
            <ul className="space-y-2">
              {plan.unbudgeted.map((row) => (
                <PlanRow key={row.categoryId} row={row} money={money} />
              ))}
            </ul>
          </div>
        ) : null}
        <Link href="/plan" className="inline-flex text-sm font-medium text-primary underline-offset-4 hover:underline">
          Open the plan
        </Link>
      </CardContent>
    </Card>
  );
}

export default async function HomePage() {
  const ctx = await getActorContext();
  if (!ctx) return <Landing />;
  const books = await requireBooks();
  const home = await loadHome(books);
  const leftTone = home.leftCents < 0 ? "text-over" : "text-income";
  const money = (cents: number) => formatCents(cents, books.currency);
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
          <CardDescription>Where this month is probably headed. The month is not finished.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="font-serif text-5xl tabular-nums">{money(home.estimate.estimateCents)}</p>
          <p className="text-sm text-muted-foreground tabular-nums">{estimateParts(home.estimate, money)}</p>
          <p className="text-sm text-muted-foreground">
            {home.estimate.paceBasis === "not_enough_history"
              ? "Not enough history yet for an everyday pace, so this counts recurring bills only."
              : `About ${money(home.estimate.dailyPaceCents)} a day of everyday spending.`}
          </p>
          <Link href="/estimate" className="inline-flex text-sm font-medium text-primary underline-offset-4 hover:underline">
            See the breakdown and next month
          </Link>
        </CardContent>
      </Card>
      <PlanSoFarCard plan={home.plan} hasAccounts={home.hasAccounts} money={money} />
    </div>
  );
}
