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

/** Desktop sidebar. Settings is a destination here, not a phone tab. */
export const desktopNav = [...bookNav, settingsNav] as const;

export function isNavActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
