import type { SplitCategoryKind, SplitKind } from "@dollas/domain";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { AppTx } from "@/db/client";
import { category, categoryGroup, ledgerAccount, transaction, transactionSplit, transferPair } from "@/db/schema";

/**
 * Reads split transactions (PEN-348): a parent, its lines in order, and each
 * line's deposit. One loader backs Activity, the editor and the MCP tools.
 * A net-pay line either makes its own deposit (`deposit`, PEN-348) or is
 * linked to the bank's real one (`linked`, PEN-349), never both.
 */

export type LinkedDepositView = { id: string; accountId: string; accountName: string; occurredOn: string; payee: string; amountCents: number; deleted: boolean };

export type SplitLineView = {
  id: string;
  position: number;
  payee: string;
  amountCents: number;
  categoryId: string | null;
  categoryName: string | null;
  categoryKind: SplitCategoryKind | null;
  reimbursed: boolean;
  note: string | null;
  deposit: { id: string; accountId: string; accountName: string; amountCents: number } | null;
  linked: LinkedDepositView | null;
};

export type SplitView = {
  id: string;
  kind: SplitKind;
  clientKey: string | null;
  occurredOn: string;
  payee: string;
  amountCents: number;
  accountId: string;
  accountName: string;
  note: string | null;
  deleted: boolean;
  lines: SplitLineView[];
  replaced: { id: string; payee: string; occurredOn: string; amountCents: number }[];
};

function label(name: string, group: string | null): string {
  return group ? `${group} · ${name}` : name;
}

export async function loadSplitViews(tx: AppTx, householdId: string, parentIds: readonly string[]): Promise<Map<string, SplitView>> {
  const views = new Map<string, SplitView>();
  if (parentIds.length === 0) return views;
  const parents = await tx
    .select({
      id: transaction.id,
      kind: transaction.splitKind,
      clientKey: transaction.splitClientKey,
      occurredOn: transaction.occurredOn,
      payee: transaction.payee,
      amountCents: transaction.amountCents,
      accountId: transaction.accountId,
      accountName: ledgerAccount.name,
      note: transaction.note,
      deletedAt: transaction.deletedAt,
    })
    .from(transaction)
    .innerJoin(ledgerAccount, eq(ledgerAccount.id, transaction.accountId))
    .where(and(eq(transaction.householdId, householdId), inArray(transaction.id, [...parentIds])));
  const splitParents = parents.filter((row) => row.kind === "income" || row.kind === "allocation");
  if (splitParents.length === 0) return views;
  const ids = splitParents.map((row) => row.id);
  const children = await tx
    .select({
      id: transaction.id,
      parentId: transaction.splitParentId,
      lineId: transaction.splitLineId,
      position: transaction.splitPosition,
      payee: transaction.payee,
      amountCents: transaction.amountCents,
      accountId: transaction.accountId,
      accountName: ledgerAccount.name,
      reimbursed: transaction.splitReimbursed,
      note: transaction.note,
    })
    .from(transaction)
    .innerJoin(ledgerAccount, eq(ledgerAccount.id, transaction.accountId))
    .where(and(eq(transaction.householdId, householdId), inArray(transaction.splitParentId, ids)))
    .orderBy(asc(transaction.splitPosition), asc(transaction.id));
  const lineIds = children.filter((row) => row.lineId == null).map((row) => row.id);
  const categories =
    lineIds.length === 0
      ? []
      : await tx
          .select({
            transactionId: transactionSplit.transactionId,
            categoryId: transactionSplit.categoryId,
            name: category.name,
            groupName: categoryGroup.name,
            kind: category.kind,
          })
          .from(transactionSplit)
          .innerJoin(category, eq(category.id, transactionSplit.categoryId))
          .leftJoin(categoryGroup, eq(categoryGroup.id, category.groupId))
          .where(and(eq(transactionSplit.householdId, householdId), inArray(transactionSplit.transactionId, lineIds)));
  const categoryOf = new Map(categories.map((row) => [row.transactionId, row]));
  const replaced = await tx
    .select({ id: transaction.id, by: transaction.splitReplacedBy, payee: transaction.payee, occurredOn: transaction.occurredOn, amountCents: transaction.amountCents })
    .from(transaction)
    .where(and(eq(transaction.householdId, householdId), inArray(transaction.splitReplacedBy, ids)))
    .orderBy(asc(transaction.occurredOn), asc(transaction.id));

  for (const parent of splitParents) {
    views.set(parent.id, {
      id: parent.id,
      kind: parent.kind as SplitKind,
      clientKey: parent.clientKey,
      occurredOn: parent.occurredOn,
      payee: parent.payee,
      amountCents: parent.amountCents,
      accountId: parent.accountId,
      accountName: parent.accountName,
      note: parent.note,
      deleted: parent.deletedAt !== null,
      lines: [],
      replaced: [],
    });
  }
  for (const row of children) {
    if (row.lineId != null || !row.parentId) continue;
    const found = categoryOf.get(row.id);
    views.get(row.parentId)?.lines.push({
      id: row.id,
      position: row.position ?? 0,
      payee: row.payee,
      amountCents: row.amountCents,
      categoryId: found?.categoryId ?? null,
      categoryName: found ? label(found.name, found.groupName) : null,
      categoryKind: (found?.kind as SplitCategoryKind | undefined) ?? null,
      reimbursed: row.reimbursed,
      note: row.note,
      deposit: null,
      linked: null,
    });
  }
  for (const row of children) {
    if (row.lineId == null || !row.parentId) continue;
    const line = views.get(row.parentId)?.lines.find((item) => item.id === row.lineId);
    if (line) line.deposit = { id: row.id, accountId: row.accountId, accountName: row.accountName, amountCents: row.amountCents };
  }
  const lineOf = new Map<string, SplitLineView>();
  for (const view of views.values()) for (const line of view.lines) lineOf.set(line.id, line);
  for (const row of await loadLinkedDeposits(tx, householdId, [...lineOf.keys()])) {
    const line = lineOf.get(row.lineId);
    if (line) line.linked = row.deposit;
  }
  for (const row of replaced) {
    if (!row.by) continue;
    views.get(row.by)?.replaced.push({ id: row.id, payee: row.payee, occurredOn: row.occurredOn, amountCents: row.amountCents });
  }
  return views;
}

/** The real deposits linked to these lines (PEN-349). */
export async function loadLinkedDeposits(tx: AppTx, householdId: string, lineIds: readonly string[]): Promise<{ lineId: string; deposit: LinkedDepositView }[]> {
  if (lineIds.length === 0) return [];
  const rows = await tx
    .select({
      lineId: transferPair.lineId,
      id: transaction.id,
      accountId: transaction.accountId,
      accountName: ledgerAccount.name,
      occurredOn: transaction.occurredOn,
      payee: transaction.payee,
      amountCents: transaction.amountCents,
      deletedAt: transaction.deletedAt,
    })
    .from(transferPair)
    .innerJoin(transaction, eq(transaction.id, transferPair.depositId))
    .innerJoin(ledgerAccount, eq(ledgerAccount.id, transaction.accountId))
    .where(and(eq(transferPair.householdId, householdId), inArray(transferPair.lineId, [...lineIds])));
  return rows.map((row) => ({
    lineId: row.lineId,
    deposit: {
      id: row.id,
      accountId: row.accountId,
      accountName: row.accountName,
      occurredOn: row.occurredOn,
      payee: row.payee,
      amountCents: row.amountCents,
      deleted: row.deletedAt !== null,
    },
  }));
}
