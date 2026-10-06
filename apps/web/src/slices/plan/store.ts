import type { BudgetCategory, BudgetMonth, BudgetStore, SpendSplit, StoredBudget } from "@dollas/domain";
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import type { AppTx } from "@/db/client";
import { category, categoryBudget, categoryGroup, transaction, transactionSplit } from "@/db/schema";

/** Drizzle access for the budget service. Runs inside `withActor`, which assumes dollas_app. */
export function drizzleBudgetStore(tx: AppTx): BudgetStore {
  return {
    async listCategories(householdId) {
      const rows = await tx
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
      return rows satisfies BudgetCategory[];
    },
    async findCategory(householdId, categoryId) {
      const [row] = await tx
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
        .where(and(eq(category.id, categoryId), eq(category.householdId, householdId)));
      return row ?? null;
    },
    async listBudgets(householdId, month) {
      const rows = await tx
        .select({
          categoryId: categoryBudget.categoryId,
          amountCents: categoryBudget.amountCents,
        })
        .from(categoryBudget)
        .where(
          and(
            eq(categoryBudget.householdId, householdId),
            eq(categoryBudget.year, month.year),
            eq(categoryBudget.month, month.month),
          ),
        );
      return rows satisfies StoredBudget[];
    },
    async listSpending(householdId, range) {
      const rows = await tx
        .select({
          categoryId: transactionSplit.categoryId,
          kind: category.kind,
          amountCents: transactionSplit.amountCents,
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
      return rows satisfies SpendSplit[];
    },
    async upsertBudget(input: {
      householdId: string;
      categoryId: string;
      month: BudgetMonth;
      amountCents: number;
    }) {
      await tx
        .insert(categoryBudget)
        .values({
          householdId: input.householdId,
          categoryId: input.categoryId,
          year: input.month.year,
          month: input.month.month,
          amountCents: input.amountCents,
        })
        .onConflictDoUpdate({
          target: [categoryBudget.categoryId, categoryBudget.year, categoryBudget.month],
          set: { amountCents: input.amountCents },
        });
    },
    async deleteBudget(input) {
      await tx
        .delete(categoryBudget)
        .where(
          and(
            eq(categoryBudget.householdId, input.householdId),
            eq(categoryBudget.categoryId, input.categoryId),
            eq(categoryBudget.year, input.month.year),
            eq(categoryBudget.month, input.month.month),
          ),
        );
    },
  };
}
