import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PayeeRules } from "./payee-rule-form";

const categories = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Groceries",
    kind: "expense",
    sortOrder: 0,
    groupId: null,
    groupName: null,
    groupSort: null,
  },
];

describe("payee rules form", () => {
  it("offers removal and apply-to-existing for a saved rule", () => {
    const html = renderToStaticMarkup(
      <PayeeRules
        categories={categories}
        rules={[
          {
            id: "22222222-2222-4222-8222-222222222222",
            pattern: "Market",
            categoryId: categories[0].id,
            categoryName: "Groceries",
          },
        ]}
      />,
    );
    expect(html).toContain("Remove rule");
    expect(html).toContain("Apply to existing");
    expect(html).toContain("A longer match wins.");
    expect(html).toContain("Now: Groceries");
    expect(html).not.toMatch(/DATABASE_|BANK_CONNECTION|SIMPLEFIN/i);
  });
});
