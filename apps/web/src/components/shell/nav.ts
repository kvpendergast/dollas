/** Phone tab bar. Settings stays in the header account menu so this list does not gain another tab. */
export const bookNav = [
  { href: "/", label: "Home" },
  { href: "/activity", label: "Activity" },
  { href: "/accounts", label: "Accounts" },
  { href: "/categories", label: "Categories" },
  { href: "/plan", label: "Plan" },
  { href: "/history", label: "History" },
] as const;

export const settingsNav = { href: "/settings", label: "Settings" } as const;

/** Recurring bills and paychecks: a sidebar entry on desktop, reached from Plan on a phone. */
export const recurringNav = { href: "/recurring", label: "Recurring" } as const;

/** Desktop sidebar. Recurring sits under Plan; Settings is a destination here, not a phone tab. */
export const desktopNav = [...bookNav.slice(0, 5), recurringNav, ...bookNav.slice(5), settingsNav] as const;

/** Phone tabs: Recurring lives under the Plan tab, so Plan stays lit there. */
export function isPhoneTabActive(pathname: string, href: string): boolean {
  if (href === "/plan" && isNavActive(pathname, recurringNav.href)) return true;
  return isNavActive(pathname, href);
}

export function isNavActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
