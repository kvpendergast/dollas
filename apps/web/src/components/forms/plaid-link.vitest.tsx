import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PlaidLinkForm } from "./plaid-link";

const setupLeak = /PLAID_CLIENT_ID|PLAID_SECRET|PLAID_ENV|PLAID_REDIRECT_URI|BANK_CONNECTION_KEYS|not configured|server log/;

describe("Plaid link option", () => {
  it("hides the Plaid option when the server says Plaid is off", () => {
    const html = renderToStaticMarkup(<PlaidLinkForm enabled={false} />);
    expect(html).toBe("");
    expect(html).not.toMatch(setupLeak);
    expect(html).not.toContain("Link with Plaid");
    expect(html).not.toContain("Plaid");
  });

  it("shows the Plaid link action without setup instructions when Plaid is on", () => {
    const html = renderToStaticMarkup(<PlaidLinkForm enabled />);
    expect(html).toContain("Link with Plaid");
    expect(html).toContain("bank password stays there");
    expect(html).not.toMatch(setupLeak);
  });
});
