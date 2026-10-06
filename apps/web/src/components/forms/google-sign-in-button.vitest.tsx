import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GoogleSignInButton } from "./google-sign-in-button";

const setupLeak = /GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|RESEND_|not configured|server log|\bResend\b/;

describe("Google sign-in button", () => {
  it("hides the button when the server says Google sign-in is off", () => {
    const html = renderToStaticMarkup(<GoogleSignInButton enabled={false} onSignIn={() => undefined} />);
    expect(html).toBe("");
    expect(html).not.toMatch(setupLeak);
    expect(html).not.toContain("Continue with Google");
  });

  it("shows only the sign-in action when the server says Google sign-in is on", () => {
    const html = renderToStaticMarkup(<GoogleSignInButton enabled onSignIn={() => undefined} />);
    expect(html).toContain("Continue with Google");
    expect(html).not.toMatch(setupLeak);
  });
});
