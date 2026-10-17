import type { PnlStore } from "@dollas/domain";
import { and, eq, gte, isNull, lte, or, gt, lt } from "drizzle-orm";
import type { AppTx } from "@/db/client";
import { category, categoryBudget, categoryGroup, transaction, transactionSplit } from "@/db/schema";

/** Drizzle reads for the profit and loss report. Runs inside `withActor` (dollas_app, household RLS). */
export function drizzleProfitLossStore(tx: AppTx): PnlStore {
  return {
    async listCategories(householdId) {
      return tx
        .select({
          id: category.id,
          householdId: category.householdId,
          name: category.name,
          kind: category.kind,
          sortOrder: category.sortOrder,
          groupId: category.groupId,
          groupName: categoryGroup.name,
          groupSort: categoryGroup.sortOrder,
        })
        .from(category)
        .leftJoin(categoryGroup, eq(categoryGroup.id, category.groupId))
        .where(eq(category.householdId, householdId));
    },
    async listBudgets(householdId, range) {
      const afterStart = or(gt(categoryBudget.year, range.from.year), and(eq(categoryBudget.year, range.from.year), gte(categoryBudget.month, range.from.month)));
      const beforeEnd = or(lt(categoryBudget.year, range.to.year), and(eq(categoryBudget.year, range.to.year), lte(categoryBudget.month, range.to.month)));
      return tx
        .select({
          categoryId: categoryBudget.categoryId,
          year: categoryBudget.year,
          month: categoryBudget.month,
          amountCents: categoryBudget.amountCents,
        })
        .from(categoryBudget)
        .where(and(eq(categoryBudget.householdId, householdId), afterStart, beforeEnd));
    },
    async listSplits(householdId, range) {
      return tx
        .select({
          categoryId: transactionSplit.categoryId,
          kind: category.kind,
          amountCents: transactionSplit.amountCents,
          occurredOn: transaction.occurredOn,
        })
        .from(transactionSplit)
        .innerJoin(transaction, eq(transaction.id, transactionSplit.transactionId))
        .innerJoin(category, eq(category.id, transactionSplit.categoryId))
        .where(
          and(
            eq(transaction.householdId, householdId),
            eq(transactionSplit.householdId, householdId),
            isNull(transaction.deletedAt),
            gte(transaction.occurredOn, range.start),
            lte(transaction.occurredOn, range.end),
          ),
        );
    },
  };
}
