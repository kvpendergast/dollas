import { resolveFilterRange, UNCATEGORIZED, UNKNOWN_MEMBER, type SpendingFilter } from "@dollas/domain";
import { and, eq, gte, ilike, inArray, isNotNull, isNull, lte, notLike, or, sql, type SQL } from "drizzle-orm";
import { category, recurringLink, transaction, transactionSplit } from "@/db/schema";

/**
 * SQL for the shared spending filter (PEN-212). Activity and list_transactions
 * use the transaction-level conditions; the Spending dashboard adds the
 * line-level category condition so a filtered total counts only the matching
 * category lines of a split transaction. Every query still runs through
 * withActor, so RLS applies on top of the household condition.
 */

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function memberCondition(column: typeof transaction.createdByUserId | typeof transaction.categorizedByUserId, ids: readonly string[]): SQL | undefined {
  const known = ids.filter((id) => id !== UNKNOWN_MEMBER);
  const parts: SQL[] = [];
  if (known.length > 0) parts.push(inArray(column, known));
  if (ids.includes(UNKNOWN_MEMBER)) parts.push(isNull(column));
  return parts.length === 1 ? parts[0] : or(...parts);
}

/**
 * Every transaction has at least one category line; import and sync put rows
 * they cannot categorize in the "Uncategorized" (expense) or "Uncategorized
 * income" category. The uncategorized filter means those two.
 */
export const FALLBACK_CATEGORY_NAMES = { expense: "Uncategorized", income: "Uncategorized income" } as const;
const isFallbackCategory = () =>
  sql`((${category.kind} = 'expense' and ${category.name} = ${FALLBACK_CATEGORY_NAMES.expense}) or (${category.kind} = 'income' and ${category.name} = ${FALLBACK_CATEGORY_NAMES.income}))`;

const isCsv = () => and(isNotNull(transaction.importFingerprint), notLike(transaction.importFingerprint, "bank:%"));

/** Conditions on `transaction` rows, for a query whose FROM is the transaction table. */
export function transactionConditions(householdId: string, filter: SpendingFilter, today: string): SQL[] {
  const where: SQL[] = [eq(transaction.householdId, householdId)];
  const range = resolveFilterRange(filter, today);
  if (range.from) where.push(gte(transaction.occurredOn, range.from));
  if (range.to) where.push(lte(transaction.occurredOn, range.to));
  if (filter.accountIds.length > 0) where.push(inArray(transaction.accountId, filter.accountIds));

  const categoryIds = filter.categoryIds.filter((id) => id !== UNCATEGORIZED);
  const categoryParts: SQL[] = [];
  if (categoryIds.length > 0) {
    categoryParts.push(
      sql`exists (select 1 from ${transactionSplit} where ${transactionSplit.transactionId} = ${transaction.id} and ${inArray(transactionSplit.categoryId, categoryIds)})`,
    );
  }
  if (filter.groupIds.length > 0) {
    categoryParts.push(
      sql`exists (select 1 from ${transactionSplit} join ${category} on ${category.id} = ${transactionSplit.categoryId} where ${transactionSplit.transactionId} = ${transaction.id} and ${inArray(category.groupId, filter.groupIds)})`,
    );
  }
  if (filter.categoryIds.includes(UNCATEGORIZED)) {
    categoryParts.push(
      sql`exists (select 1 from ${transactionSplit} join ${category} on ${category.id} = ${transactionSplit.categoryId} where ${transactionSplit.transactionId} = ${transaction.id} and ${isFallbackCategory()})`,
    );
  }
  if (categoryParts.length > 0) where.push(categoryParts.length === 1 ? categoryParts[0] : (or(...categoryParts) as SQL));

  if (filter.memberIds.length > 0) {
    const added = memberCondition(transaction.createdByUserId, filter.memberIds);
    const categorized = memberCondition(transaction.categorizedByUserId, filter.memberIds);
    const condition = filter.memberRole === "added" ? added : filter.memberRole === "categorized" ? categorized : or(added, categorized);
    if (condition) where.push(condition);
  }

  if (filter.sources.length > 0 && filter.sources.length < 3) {
    const parts: SQL[] = [];
    if (filter.sources.includes("bank")) parts.push(isNotNull(transaction.bankTransactionId));
    if (filter.sources.includes("csv")) parts.push(isCsv() as SQL);
    if (filter.sources.includes("manual")) {
      parts.push(and(isNull(transaction.bankTransactionId), or(isNull(transaction.importFingerprint), sql`${transaction.importFingerprint} like 'bank:%'`)) as SQL);
    }
    where.push(parts.length === 1 ? parts[0] : (or(...parts) as SQL));
  }

  if (filter.recurring !== "any") {
    const linked = sql`exists (select 1 from ${recurringLink} where ${recurringLink.transactionId} = ${transaction.id})`;
    where.push(filter.recurring === "linked" ? linked : sql`not ${linked}`);
  }
  if (filter.minCents != null) where.push(sql`abs(${transaction.amountCents}) >= ${filter.minCents}`);
  if (filter.maxCents != null) where.push(sql`abs(${transaction.amountCents}) <= ${filter.maxCents}`);
  if (filter.search) {
    const pattern = `%${escapeLike(filter.search)}%`;
    where.push(or(ilike(transaction.payee, pattern), ilike(transaction.note, pattern)) as SQL);
  }
  return where;
}

/**
 * For a query joining transaction_split and category: keep only the category
 * lines the filter asks for, so a split transaction counts only its matching
 * lines.
 */
export function lineCondition(filter: SpendingFilter): SQL | undefined {
  const categoryIds = filter.categoryIds.filter((id) => id !== UNCATEGORIZED);
  if (filter.categoryIds.length === 0 && filter.groupIds.length === 0) return undefined;
  const parts: SQL[] = [];
  if (categoryIds.length > 0) parts.push(inArray(transactionSplit.categoryId, categoryIds));
  if (filter.groupIds.length > 0) parts.push(inArray(category.groupId, filter.groupIds));
  if (filter.categoryIds.includes(UNCATEGORIZED)) parts.push(isFallbackCategory());
  return parts.length === 1 ? parts[0] : or(...parts);
}

/** Where a transaction came from, for display: CSV and bank can both be true. */
export function sourceOf(row: { importFingerprint: string | null; bankTransactionId: string | null }): Array<"manual" | "csv" | "bank"> {
  const csv = row.importFingerprint != null && !row.importFingerprint.startsWith("bank:");
  const bank = row.bankTransactionId != null;
  if (!csv && !bank) return ["manual"];
  return [...(csv ? (["csv"] as const) : []), ...(bank ? (["bank"] as const) : [])];
}
