import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TransactionEditor, unsignedDollarInput } from "./transaction-editor";

const food = "11111111-1111-4111-8111-111111111111";
const dining = "22222222-2222-4222-8222-222222222222";
const categories = [
  { id: food, name: "Groceries", kind: "expense", sortOrder: 0, groupId: null, groupName: null, groupSort: null },
  { id: dining, name: "Dining out", kind: "expense", sortOrder: 1, groupId: null, groupName: null, groupSort: null },
];
const accounts = [{ id: "33333333-3333-4333-8333-333333333333", name: "Amazon Prime credit card" }];

function html(amountCents: number, note: string | null = null) {
  return renderToStaticMarkup(
    <TransactionEditor
      initialOpen
      transaction={{ id: "t1", payee: "PRET A MANGER", occurredOn: "2026-01-31", amountCents, accountId: accounts[0].id, note, splits: [{ categoryId: food, amountCents }] }}
      accounts={accounts}
      categories={categories}
      onDeleted={() => {}}
    />,
  );
}

describe("transaction edit form amount", () => {
  it("prefills unsigned dollars for negative (imported expense) and positive amounts", () => {
    expect(unsignedDollarInput(-1794)).toBe("17.94");
    expect(unsignedDollarInput(1794)).toBe("17.94");
    expect(unsignedDollarInput(-5)).toBe("0.05");
  });
  it("always renders a labelled Amount field with the existing amount, so a category-only edit can save", () => {
    const out = html(-1794);
    expect(out).toContain(">Amount</label>");
    expect(out).toMatch(/<input[^>]*name="amount"[^>]*value="17.94"/);
    expect(out).toContain('name="direction" value="expense"');
  });
  it("renders an optional Note field with the existing note, capped at 500", () => {
    const out = html(-1794, "for the party");
    expect(out).toContain("Note (optional)</label>");
    expect(out).toMatch(/<textarea[^>]*name="note"[^>]*maxLength="500"|<textarea[^>]*maxlength="500"[^>]*name="note"|<textarea[^>]*name="note"[^>]*maxlength="500"/i);
    expect(out).toContain(">for the party</textarea>");
    expect(html(-1794)).toMatch(/<textarea[^>]*name="note"[^>]*><\/textarea>/);
  });
});
