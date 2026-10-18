import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SignUpForm } from "./auth-forms";

const token = "a".repeat(43);

describe("sign-up from an invite link", () => {
  it("shows the invited address read-only and never submits an email field", () => {
    const html = renderToStaticMarkup(<SignUpForm googleEnabled={false} path="join" invite={{ token, maskedEmail: "b***@example.com" }} />);
    expect(html).toMatch(/<input[^>]*id="join-email"[^>]*readOnly=""[^>]*/);
    expect(html).toContain('value="b***@example.com"');
    expect(html).not.toMatch(/name="email"/);
    expect(html).toContain('name="invite"');
  });
  it("keeps the editable email without an invite", () => {
    const html = renderToStaticMarkup(<SignUpForm googleEnabled={false} path="start" />);
    expect(html).toMatch(/name="email"/);
    expect(html).not.toMatch(/readOnly/);
  });
});
