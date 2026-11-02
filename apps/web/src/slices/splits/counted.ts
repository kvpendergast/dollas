import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { transaction } from "@/db/schema";

/**
 * The one place reports decide which rows count (PEN-348). Every query over
 * `transaction` that adds money up uses one of these:
 *
 * - Balances (account balances, Home's account total): every posted row
 *   except an allocation split's parent, whose lines carry its money instead.
 *   A paycheck (income split) parent counts, and so do its lines and deposits,
 *   so a clearing account nets to zero and the bank account gets net pay.
 * - Books (income, spending, budgets, P&L, estimate, history, recurring,
 *   payees): the same rows minus lines marked reimbursed (a friend's share).
 *
 * Bank sync and bulk recategorizing leave split rows alone: see isSplitRow.
 */
export function countsInBalances(): SQL {
  return sql`${transaction.splitKind} is distinct from 'allocation'`;
}

export function countsInBooks(): SQL {
  return and(countsInBalances(), sql`not ${transaction.splitReimbursed}`) as SQL;
}

/** Posted (not deleted) household rows that count toward balances. */
export function postedForBalances(householdId: string): SQL {
  return and(eq(transaction.householdId, householdId), isNull(transaction.deletedAt), countsInBalances()) as SQL;
}

/** Posted household rows that count toward income and spending. */
export function postedForBooks(householdId: string): SQL {
  return and(eq(transaction.householdId, householdId), isNull(transaction.deletedAt), countsInBooks()) as SQL;
}

/** A split parent, line, or deposit. */
export function isSplitRow(): SQL<boolean> {
  return sql<boolean>`(${transaction.splitKind} is not null or ${transaction.splitParentId} is not null)`;
}

export function notSplitRow(): SQL {
  return sql`(${transaction.splitKind} is null and ${transaction.splitParentId} is null)`;
}
