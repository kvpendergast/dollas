import { parseDollarInput, validateSplits, type BalancedSplit } from "@dollas/domain";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type TransactionDraft = {
  payee: string;
  occurredOn: string;
  accountId: string;
  amountCents: number;
  splits: BalancedSplit[];
};

/**
 * Shared by creating a transaction and correcting one. Amounts stay integer
 * cents, and a split is refused unless the parts add up to the total.
 */
export function readTransactionDraft(formData: FormData): { error: string } | { draft: TransactionDraft } {
  const payee = String(formData.get("payee") ?? "").trim();
  const occurredOn = String(formData.get("occurredOn") ?? "");
  const accountId = String(formData.get("accountId") ?? "");
  const direction = String(formData.get("direction") ?? "expense") === "income" ? 1 : -1;
  const amount = parseDollarInput(String(formData.get("amount") ?? ""));
  const categoryIds = formData.getAll("categoryId").map(String).filter(Boolean);
  const splitAmounts = formData.getAll("splitAmount").map(String);
  if (payee.length < 1) return { error: "Enter a payee." };
  if (!ISO_DATE.test(occurredOn)) return { error: "Choose a date." };
  if (amount.isErr()) return { error: amount.error.message };
  if (amount.value <= 0) return { error: "Enter an amount greater than zero." };
  const total = amount.value * direction;
  const drafts =
    categoryIds.length <= 1
      ? [{ categoryId: categoryIds[0] ?? "", amountCents: total }]
      : categoryIds.map((categoryId, index) => {
          const parsed = parseDollarInput(splitAmounts[index] ?? "");
          return {
            categoryId,
            amountCents: parsed.isOk() ? parsed.value * direction : Number.NaN,
          };
        });
  const balanced = validateSplits(total, drafts);
  if (balanced.isErr()) return { error: balanced.error.message };
  return {
    draft: {
      payee,
      occurredOn,
      accountId,
      amountCents: total,
      splits: balanced.value,
    },
  };
}
