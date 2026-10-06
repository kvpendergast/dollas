import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountMenuPanel } from "@/components/shell/account-menu";
import { bookNav, desktopNav } from "@/components/shell/nav";
import { PhoneTabBar } from "@/components/shell/phone-nav";
import { DesktopNav } from "@/components/shell/sidebar";
import { leaveHouseholdCopy, passwordSectionCopy } from "@/components/forms/settings-forms";

const setupLeak = /GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|RESEND_|BETTER_AUTH_|DATABASE_|PLAID_|not configured/;

describe("settings navigation", () => {
  it("puts Settings in the desktop nav and the phone account menu, not the phone tabs", () => {
    expect(desktopNav.map((item) => item.label)).toContain("Settings");
    expect(desktopNav.find((item) => item.label === "Settings")?.href).toBe("/settings");
    expect(bookNav.map((item) => item.label)).not.toContain("Settings");
    expect(bookNav.map((item) => item.label)).toEqual(["Home", "Activity", "Accounts", "Categories", "Plan", "History"]);

    const desktop = renderToStaticMarkup(<DesktopNav pathname="/settings" />);
    expect(desktop).toContain('href="/settings"');
    expect(desktop).toContain("Settings");
    expect(desktop).toContain('aria-current="page"');

    const phone = renderToStaticMarkup(<PhoneTabBar pathname="/" />);
    expect(phone).not.toContain("/settings");
    expect(phone).not.toContain("Settings");
    expect(phone).toContain("Home");
    expect(phone).toContain("History");

    const account = renderToStaticMarkup(<AccountMenuPanel pathname="/activity" />);
    expect(account).toContain('aria-label="Account"');
    expect(account).toContain('href="/settings"');
    expect(account).toContain("Settings");
    expect(account).not.toMatch(setupLeak);
  });
});

describe("settings copy", () => {
  it("explains a Google-only login without setup strings", () => {
    const copy = passwordSectionCopy("google");
    expect(copy).toBe("You sign in with Google. There is no password to change here.");
    expect(copy).not.toMatch(setupLeak);
    expect(passwordSectionCopy("password")).toBeNull();
    expect(passwordSectionCopy("none")).toBe("This login does not use a password.");
  });

  it("confirms leaving, and blocks the last owner", () => {
    const leaving = leaveHouseholdCopy(false, "Maple House");
    expect(leaving.title).toBe("Leave Maple House?");
    expect(leaving.body).toContain("Your login stays yours.");

    const blocked = leaveHouseholdCopy(true, "Maple House");
    expect(blocked.title).toBe("You are the last owner");
    expect(blocked.body).toContain("Hand ownership to another member");
    expect(blocked.body).toContain("delete the household");
    expect(blocked.body).not.toMatch(setupLeak);
  });
});
