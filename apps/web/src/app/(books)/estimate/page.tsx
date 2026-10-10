import { formatCents, type EstimateMonth } from "@dollas/domain";
import Link from "next/link";
import { describePace, monthName } from "@/components/estimate/explain";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireBooks } from "@/slices/access/guard";
import { getSpendEstimate } from "@/slices/books/service";

function Row({ label, value, detail, strong }: { label: string; value: string; detail?: string; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 py-2 text-sm ${strong ? "border-t border-border pt-3 font-medium" : ""}`}>
      <div className="min-w-0">
        <p>{label}</p>
        {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
      </div>
      <span className={`shrink-0 tabular-nums ${strong ? "font-serif text-xl" : ""}`}>{value}</span>
    </div>
  );
}

function MonthCard({
  title,
  month,
  current,
  dailyCents,
  money,
}: {
  title: string;
  month: EstimateMonth;
  current: boolean;
  dailyCents: number;
  money: (cents: number) => string;
}) {
  const budget =
    month.underBudgetCents == null || month.budgetCents == null
      ? null
      : month.underBudgetCents >= 0
        ? { text: `${money(month.underBudgetCents)} under the ${money(month.budgetCents)} plan`, tone: "text-income" }
        : { text: `${money(-month.underBudgetCents)} over the ${money(month.budgetCents)} plan`, tone: "text-over" };
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardDescription>{title}</CardDescription>
          <Badge variant="secondary">Estimate</Badge>
        </div>
        <CardTitle className="font-serif text-4xl tabular-nums">{money(month.estimateCents)}</CardTitle>
        {budget ? <p className={`text-sm ${budget.tone}`}>{budget.text}</p> : null}
      </CardHeader>
      <CardContent>
        {current ? <Row label="Spent so far" value={money(month.spentSoFarCents)} detail="Every expense through today" /> : null}
        <Row
          label={current ? "Recurring still expected" : "Recurring expected"}
          value={money(month.recurringExpectedCents)}
          detail={
            month.recurringMissedCents > 0
              ? `${money(month.recurringMissedCents)} missed and not counted`
              : current && month.recurringPaidCents > 0
                ? `${money(month.recurringPaidCents)} already paid, in spent so far`
                : "From your recurring bills"
          }
        />
        <Row
          label="Everyday spending ahead"
          value={money(month.paceCents)}
          detail={month.paceDays === 0 ? "No days left this month" : `${money(dailyCents)} a day × ${month.paceDays} days`}
        />
        <Row label="Spend estimate" value={money(month.estimateCents)} strong />
        {month.moneyLeftCents != null ? (
          <div className="mt-3 rounded-lg bg-muted px-3 py-2 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">{current ? "Income so far and expected" : "Recurring income expected"}</span>
              <span className="tabular-nums text-income">{money(month.incomeCents)}</span>
            </div>
            <div className="flex justify-between gap-3 font-medium">
              <span>Expected money left</span>
              <span className={`tabular-nums ${month.moneyLeftCents < 0 ? "text-over" : "text-income"}`}>{money(month.moneyLeftCents)}</span>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default async function EstimatePage() {
  const books = await requireBooks();
  const result = await getSpendEstimate(books);
  if (!result.ok) throw new Error(result.memberMessage);
  const estimate = result.value;
  const money = (cents: number) => formatCents(cents, books.currency);
  const thisName = monthName(estimate.thisMonth.month);
  const nextName = monthName(estimate.nextMonth.month);
  const noPace = estimate.pace.basis === "not_enough_history";

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="font-serif text-4xl">Spend estimate</h1>
          <Badge>Estimate</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          What {thisName} and {nextName} will probably cost, from your recurring bills plus your everyday pace. It will move as
          real transactions come in.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <MonthCard title={`Rest of ${thisName}`} month={estimate.thisMonth} current dailyCents={estimate.pace.dailyCents} money={money} />
        <MonthCard title={`All of ${nextName}`} month={estimate.nextMonth} current={false} dailyCents={estimate.pace.dailyCents} money={money} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>How this is worked out</CardTitle>
          <CardDescription>{describePace(estimate.pace, books.currency)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          {estimate.pace.basis === "blended" ? (
            <p>
              This month counts for {estimate.pace.thisMonthWeightPercent}% of the pace today and more each day, so a big first
              week doesn&apos;t swing the whole month.
            </p>
          ) : null}
          <p>
            Everyday spending leaves out income, transfers, and anything linked to a{" "}
            <Link href="/recurring" className="font-medium text-primary underline-offset-4 hover:underline">
              recurring item
            </Link>
            . Recurring bills are added on their own: still expected until their date window closes, then counted as missed.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>By category</CardTitle>
          <CardDescription>
            {noPace ? "Spent so far plus recurring bills." : "Spent so far, recurring bills, and everyday pace for each category."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {estimate.categories.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing to estimate yet. Add transactions or a recurring bill.</p>
          ) : (
            <div>
              <div className="hidden grid-cols-[1fr_repeat(4,6.5rem)_7rem] gap-2 border-b border-border pb-2 text-xs text-muted-foreground md:grid">
                <span>Category</span>
                <span className="text-right">So far</span>
                <span className="text-right">Recurring</span>
                <span className="text-right">Pace</span>
                <span className="text-right">{thisName}</span>
                <span className="text-right">{nextName}</span>
              </div>
              <ul className="divide-y divide-border">
                {estimate.categories.map((line) => (
                  <li key={line.categoryId ?? "none"} className="py-2 text-sm">
                    <div className="hidden grid-cols-[1fr_repeat(4,6.5rem)_7rem] items-baseline gap-2 tabular-nums md:grid">
                      <span className="truncate">{line.name}</span>
                      <span className="text-right">{money(line.thisMonth.spentSoFarCents)}</span>
                      <span className="text-right">{money(line.thisMonth.recurringCents)}</span>
                      <span className="text-right">{money(line.thisMonth.paceCents)}</span>
                      <span className="text-right font-medium">{money(line.thisMonth.estimateCents)}</span>
                      <span className="text-right text-muted-foreground">{money(line.nextMonth.estimateCents)}</span>
                    </div>
                    <div className="md:hidden">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="truncate font-medium">{line.name}</span>
                        <span className="tabular-nums">{money(line.thisMonth.estimateCents)}</span>
                      </div>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {money(line.thisMonth.spentSoFarCents)} so far · {money(line.thisMonth.recurringCents)} recurring ·{" "}
                        {money(line.thisMonth.paceCents)} pace · {nextName} {money(line.nextMonth.estimateCents)}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        An estimate, not a closed total. Today is {estimate.today} in your household&apos;s time zone.{" "}
        <Link href="/" className="font-medium text-primary underline-offset-4 hover:underline">
          Back to this month
        </Link>
      </p>
    </div>
  );
}
