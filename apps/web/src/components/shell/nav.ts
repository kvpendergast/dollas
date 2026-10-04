export const bookNav = [
  { href: "/", label: "Home" },
  { href: "/activity", label: "Activity" },
  { href: "/accounts", label: "Accounts" },
  { href: "/plan", label: "Plan" },
  { href: "/history", label: "History" },
] as const;

export function isNavActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
