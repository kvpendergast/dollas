import { isFallbackCategory } from "@dollas/domain";
import { and, eq, isNull } from "drizzle-orm";
import { withActor } from "@/db/actor";
import { category, transaction, transactionSplit } from "@/db/schema";
import { failure, succeed, type ServiceActor, type ServiceResult } from "@/lib/service-result";

/**
 * Payees as a household has them (PEN-282): one row per payee (ignoring case
 * and outer spaces) with how many transactions, their signed total, and how
 * many are still uncategorized. Deleted transactions are left out. A
 * transaction counts as uncategorized when any of its category lines is the
 * Uncategorized (or Uncategorized income) fallback.
 */

export type PayeeSummary = {
  payee: string;
  transactionCount: number;
  totalCents: number;
  uncategorizedCount: number;
  /** Distinct categories used by this payee's transactions, up to three, most used first. */
  topCategories: string[];
};

export type PayeeList = {
  payeeCount: number;
  transactionCount: number;
  totalCents: number;
  uncategorizedTransactionCount: number;
  payees: PayeeSummary[];
};

export type PayeeSort = "transactions" | "total" | "uncategorized" | "name";

export async function listHouseholdPayees(
  actor: ServiceActor,
  filter: { contains?: string; uncategorizedOnly?: boolean; sort?: PayeeSort } = {},
): Promise<ServiceResult<PayeeList>> {
  try {
    const { rows, splits } = await withActor(actor.userId, async (tx) => ({
      rows: await tx
        .select({ id: transaction.id, payee: transaction.payee, amountCents: transaction.amountCents })
        .from(transaction)
        .where(and(eq(transaction.householdId, actor.householdId), isNull(transaction.deletedAt))),
      splits: await tx
        .select({ transactionId: transactionSplit.transactionId, name: category.name, kind: category.kind })
        .from(transactionSplit)
        .innerJoin(category, eq(category.id, transactionSplit.categoryId))
        .where(eq(transactionSplit.householdId, actor.householdId)),
    }));
    const byTransaction = new Map<string, { name: string; kind: string }[]>();
    for (const split of splits) {
      const list = byTransaction.get(split.transactionId) ?? [];
      list.push(split);
      byTransaction.set(split.transactionId, list);
    }
    const groups = new Map<string, PayeeSummary & { categories: Map<string, number> }>();
    let uncategorizedTotal = 0;
    let totalCents = 0;
    for (const row of rows) {
      const key = row.payee.trim().toLowerCase();
      const group =
        groups.get(key) ??
        { payee: row.payee.trim(), transactionCount: 0, totalCents: 0, uncategorizedCount: 0, topCategories: [], categories: new Map<string, number>() };
      const lines = byTransaction.get(row.id) ?? [];
      group.transactionCount += 1;
      group.totalCents += row.amountCents;
      totalCents += row.amountCents;
      if (lines.some((line) => isFallbackCategory(line))) {
        group.uncategorizedCount += 1;
        uncategorizedTotal += 1;
      }
      for (const line of lines) group.categories.set(line.name, (group.categories.get(line.name) ?? 0) + 1);
      groups.set(key, group);
    }
    const needle = filter.contains?.trim().toLowerCase() ?? "";
    const sort = filter.sort ?? "transactions";
    const payees = [...groups.values()]
      .filter((group) => (needle ? group.payee.toLowerCase().includes(needle) : true))
      .filter((group) => (filter.uncategorizedOnly ? group.uncategorizedCount > 0 : true))
      .map(({ categories, ...group }) => ({
        ...group,
        topCategories: [...categories.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([name]) => name),
      }))
      .sort((a, b) => {
        if (sort === "name") return a.payee.localeCompare(b.payee);
        if (sort === "total") return Math.abs(b.totalCents) - Math.abs(a.totalCents) || a.payee.localeCompare(b.payee);
        if (sort === "uncategorized") return b.uncategorizedCount - a.uncategorizedCount || a.payee.localeCompare(b.payee);
        return b.transactionCount - a.transactionCount || a.payee.localeCompare(b.payee);
      });
    return succeed({
      payeeCount: groups.size,
      transactionCount: rows.length,
      totalCents,
      uncategorizedTransactionCount: uncategorizedTotal,
      payees,
    });
  } catch (error) {
    return failure(error, "Could not load payees.", { action: "list-payees", householdId: actor.householdId });
  }
}
