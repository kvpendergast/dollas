import { formatCents, monthLabel } from "@dollas/domain";
import { BudgetForm } from "@/components/forms/budget-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireBooks } from "@/slices/access/guard";
import { loadPlan } from "@/slices/books/queries";

function dollarsInput(cents: number | null): string {
  if (cents === null) return "";
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export default async function PlanPage() {
  const books = await requireBooks();
  const plan = await loadPlan(books);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-4xl">Plan</h1>
        <p className="text-sm text-muted-foreground">
          {monthLabel(books.asOf.year, books.asOf.month)}, category by category. Each category gets a budget for the month.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardDescription>Income so far</CardDescription>
          <CardTitle className="font-serif text-3xl text-income tabular-nums">{formatCents(plan.incomeCents)}</CardTitle>
        </CardHeader>
      </Card>
      <div className="space-y-3">
        {plan.expense.map((category) => {
          const width =
            category.budgetCents && category.budgetCents > 0
              ? Math.min(100, Math.round((category.spentCents / category.budgetCents) * 100))
              : category.spentCents > 0
                ? 100
                : 0;
          const over = category.standing === "over";
          return (
            <Card key={category.categoryId}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle>{category.name}</CardTitle>
                    <CardDescription className={over ? "text-over" : undefined}>
                      {formatCents(category.spentCents)} spent
                      {category.budgetCents === null
                        ? " · no budget"
                        : ` of ${formatCents(category.budgetCents)}${over ? " · over budget" : ""}`}
                    </CardDescription>
                  </div>
                  <BudgetForm categoryId={category.categoryId} defaultDollars={dollarsInput(category.budgetCents)} />
                </div>
              </CardHeader>
              <CardContent>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div className={`h-full ${over ? "bg-over" : "bg-bar"}`} style={{ width: `${width}%` }} />
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
