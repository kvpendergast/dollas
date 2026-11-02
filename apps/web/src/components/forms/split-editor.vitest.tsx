import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityLedger } from "./activity-ledger";
import { SplitEditor } from "./split-editor";
import { TransactionEditor } from "./transaction-editor";

const salary = "11111111-1111-4111-8111-111111111111";
const taxes = "22222222-2222-4222-8222-222222222222";
const netPay = "33333333-3333-4333-8333-333333333333";
const groceries = "44444444-4444-4444-8444-444444444444";
const gifts = "55555555-5555-4555-8555-555555555555";
const payroll = "66666666-6666-4666-8666-666666666666";
const bank = "77777777-7777-4777-8777-777777777777";
const categories = [
  { id: salary, name: "Salary", kind: "income", sortOrder: 0, groupId: null, groupName: null, groupSort: null },
  { id: taxes, name: "Taxes", kind: "expense", sortOrder: 1, groupId: null, groupName: null, groupSort: null },
  { id: netPay, name: "Net pay", kind: "transfer", sortOrder: 2, groupId: null, groupName: null, groupSort: null },
  { id: groceries, name: "Groceries", kind: "expense", sortOrder: 3, groupId: null, groupName: null, groupSort: null },
  { id: gifts, name: "Gifts", kind: "expense", sortOrder: 4, groupId: null, groupName: null, groupSort: null },
];
const accounts = [
  { id: payroll, name: "Payroll" },
  { id: bank, name: "Bank" },
];

const view = {
  id: "pay",
  kind: "income" as const,
  clientKey: "pay-2026-10-15",
  occurredOn: "2026-10-15",
  payee: "Acme Payroll",
  amountCents: 500000,
  accountId: payroll,
  accountName: "Payroll",
  note: null,
  deleted: false,
  replaced: [],
  lines: [
    { id: "tax", position: 0, payee: "IRS", amountCents: -100000, categoryId: taxes, categoryName: "Taxes", categoryKind: "expense" as const, reimbursed: false, note: null, deposit: null },
    { id: "net", position: 1, payee: "Net pay", amountCents: -400000, categoryId: netPay, categoryName: "Net pay", categoryKind: "transfer" as const, reimbursed: false, note: null, deposit: { id: "dep", accountId: bank, accountName: "Bank", amountCents: 400000 } },
  ],
};

describe("split editor (PEN-348)", () => {
  it("explains an income split, offers Deposit to on transfer lines and shows the live difference", () => {
    const out = renderToStaticMarkup(
      <SplitEditor
        transaction={{ id: "pay", payee: "Acme Payroll", amountCents: 500000 }}
        parentCategoryIds={[salary]}
        lines={view.lines.map((line) => ({ payee: line.payee, categoryId: line.categoryId, amountCents: line.amountCents, reimbursed: false, deposit: line.deposit ? { accountId: line.deposit.accountId } : null }))}
        categories={categories}
        accounts={accounts}
        onClose={() => {}}
      />,
    );
    expect(out).toContain("A paycheck counts as gross income");
    expect(out).toContain("Deposit to");
    expect(out).not.toContain("Paid back");
    expect(out).toMatch(/role="status"[^>]*>[^<]*\$5,000\.00/);
    expect(out).toContain("Add a line");
  });

  it("offers Paid back on a store run and starts two empty lines with the full amount left", () => {
    const out = renderToStaticMarkup(
      <SplitEditor transaction={{ id: "cc", payee: "Costco", amountCents: -20000 }} parentCategoryIds={[groceries]} categories={categories} accounts={accounts} onClose={() => {}} />,
    );
    expect(out).toContain("The lines replace this transaction in every total.");
    expect(out).toContain("Paid back");
    expect(out).not.toContain("Deposit to");
    expect(out).toContain("$200.00 left to assign");
  });

  it("locks a line and gives a parent Edit split and Unsplit", () => {
    const base = { payee: "IRS", occurredOn: "2026-10-15", amountCents: -100000, accountId: payroll, note: null, splits: [{ categoryId: taxes, amountCents: -100000 }] };
    const line = renderToStaticMarkup(
      <TransactionEditor transaction={{ ...base, id: "tax", splitGroup: { role: "line", parentId: "pay", parentPayee: "Acme Payroll", reimbursed: false } }} accounts={accounts} categories={categories} onDeleted={() => {}} />,
    );
    expect(line).toContain("data-split-locked");
    expect(line).not.toContain(">Edit<");
    const parent = renderToStaticMarkup(
      <TransactionEditor
        transaction={{ ...base, id: "pay", payee: "Acme Payroll", amountCents: 500000, splits: [{ categoryId: salary, amountCents: 500000 }], splitGroup: { role: "parent", kind: "income", view } }}
        accounts={accounts}
        categories={categories}
        onDeleted={() => {}}
      />,
    );
    expect(parent).toContain("Edit split");
    expect(parent).toContain("Unsplit");
    const plain = renderToStaticMarkup(<TransactionEditor transaction={{ ...base, id: "plain" }} accounts={accounts} categories={categories} onDeleted={() => {}} />);
    expect(plain).toContain("Split into transactions");
  });

  it("nests lines and the deposit under the parent in Activity, and labels an orphan line", () => {
    const row = (id: string, payee: string, amountCents: number, splitGroup: unknown, accountId = payroll) => ({
      id,
      occurredOn: "2026-10-15",
      payee,
      amountCents,
      accountId,
      accountName: accountId === bank ? "Bank" : "Payroll",
      accountArchived: false,
      splits: [{ categoryId: taxes, categoryName: "Taxes", amountCents }],
      splitGroup: splitGroup as never,
      accounts,
    });
    const out = renderToStaticMarkup(
      <ActivityLedger
        categories={categories}
        transactions={[
          row("pay", "Acme Payroll", 500000, { role: "parent", kind: "income", view }),
          row("tax", "IRS", -100000, { role: "line", parentId: "pay", parentPayee: "Acme Payroll", reimbursed: false }),
          row("dep", "Net pay", 400000, { role: "deposit", parentId: "pay", parentPayee: "Acme Payroll" }, bank),
          row("stray", "Gifts line", -3000, { role: "line", parentId: "elsewhere", parentPayee: "Costco", reimbursed: true }),
        ]}
      />,
    );
    expect(out).toContain("Income split");
    expect(out).toContain('aria-label="Lines of Acme Payroll"');
    expect(out.match(/data-split-line/g)?.length).toBe(2);
    expect(out).toContain("Deposit to Bank");
    expect(out).toContain("data-split-orphan");
    expect(out).toContain("Part of a split: Costco");
  });
});
