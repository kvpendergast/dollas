import { formatBudgetMonth, formatCents, monthLabel, parseBudgetMonth, shiftBudgetMonth } from "@dollas/domain";
import { BudgetForm } from "@/components/forms/budget-form";
import { CopyBudgetsForm } from "@/components/forms/copy-budgets-form";
import { PlanMonthNav } from "@/components/forms/plan-month-nav";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireBooks } from "@/slices/access/guard";
import { loadCopyPreview, loadMonthPlan } from "@/slices/plan/load";

function dollarsInput(cents: number | null): string {
  if (cents === null) return "";
  return `${Math.trunc(cents / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function PlanPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string | string[]; copy?: string | string[] }>;
}) {
  const books = await requireBooks();
  const params = await searchParams;
  const requested = first(params.month);
  const current = { year: books.asOf.year, month: books.asOf.month };
  if (!requested) redirect(`/plan?month=${formatBudgetMonth(current)}`);

  const parsed = parseBudgetMonth(requested);
  const month = parsed.isOk() ? parsed.value : current;
  const monthKey = formatBudgetMonth(month);
  const label = monthLabel(month.year, month.month);
  const plan = await loadMonthPlan(books, month);
  const showCopy = first(params.copy) === "preview" && parsed.isOk();
  const copy = showCopy ? await loadCopyPreview(books, month) : null;
  const previous = shiftBudgetMonth(month, -1);
  const next = shiftBudgetMonth(month, 1);
  const partial = month.year === books.asOf.year && month.month === books.asOf.month;

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div>
          <h1 className="font-serif text-4xl">Plan</h1>
          <p className="text-sm text-muted-foreground">
            {label}, category by category. Each expense category gets a budget for the month.
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PlanMonthNav
            monthKey={monthKey}
            label={label}
            previousHref={previous.isOk() ? `/plan?month=${formatBudgetMonth(previous.value)}` : null}
            nextHref={next.isOk() ? `/plan?month=${formatBudgetMonth(next.value)}` : null}
          />
          <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline">
            <Link href="/recurring">Recurring bills and paychecks</Link>
          </Button>
          {showCopy || previous.isErr() ? null : (
            <Button asChild variant="outline">
              <Link href={`/plan?month=${monthKey}&copy=preview`}>Copy last month</Link>
            </Button>
          )}
          </div>
        </div>
        {parsed.isErr() ? (
          <p role="alert" className="text-sm text-over">
            {parsed.error.message}
          </p>
        ) : null}
      </div>
      <Card className="max-w-sm">
        <CardHeader>
          <CardDescription>{partial ? "Income so far" : "Income"}</CardDescription>
          <CardTitle className="font-serif text-3xl text-income tabular-nums">{formatCents(plan.incomeCents)}</CardTitle>
        </CardHeader>
      </Card>
      {copy ? (
        <Card>
          <CardHeader>
            <CardTitle>Copy last month</CardTitle>
            <CardDescription>Review what will change before anything is saved.</CardDescription>
          </CardHeader>
          <CardContent>
            {copy.error || !copy.preview ? (
              <p role="alert" className="text-sm text-over">
                {copy.error || "Could not read last month's budgets."}
              </p>
            ) : (
              <CopyBudgetsForm
                monthKey={monthKey}
                fromLabel={monthLabel(copy.preview.from.year, copy.preview.from.month)}
                toLabel={label}
                copies={copy.preview.copies}
                overwrites={copy.preview.overwrites}
                unchangedCount={copy.preview.unchangedCount}
              />
            )}
          </CardContent>
        </Card>
      ) : null}
      {plan.sections.length === 0 ? (
        <p className="text-sm text-muted-foreground">No expense categories yet.</p>
      ) : (
        <div className="space-y-8">
          {plan.sections.map((section) => (
            <section key={section.id} className="space-y-3" aria-labelledby={`plan-group-${section.id}`}>
              <h2 id={`plan-group-${section.id}`} className="font-serif text-2xl">
                {section.name}
              </h2>
              {section.categories.map((category) => {
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
                        <BudgetForm
                          key={`${category.categoryId}-${monthKey}-${category.budgetCents ?? "none"}`}
                          categoryId={category.categoryId}
                          categoryName={category.name}
                          month={monthKey}
                          defaultDollars={dollarsInput(category.budgetCents)}
                        />
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
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
