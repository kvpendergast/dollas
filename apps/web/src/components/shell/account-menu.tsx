"use client";

import { Settings, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { accountNav, isNavActive } from "./nav";

const icons = { Household: Users, Settings } as const;

export function AccountMenuPanel({ pathname }: { pathname: string }) {
  return (
    <nav aria-label="Account" className="dl-sheet absolute right-0 z-30 mt-2 min-w-44 rounded-xl bg-card p-2 shadow-sm ring-1 ring-foreground/10">
      <ul className="space-y-1">
        {accountNav.map((item) => {
          const Icon = icons[item.label];
          const active = isNavActive(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-11 items-center gap-2 rounded-lg px-3 text-sm ${active ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
              >
                <Icon aria-hidden="true" className="size-4" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Phone header menu. Desktop uses the sidebar, so this stays off wider screens. */
export function AccountMenu() {
  const pathname = usePathname();
  return (
    <details className="relative md:hidden">
      <summary className="flex min-h-11 cursor-pointer list-none items-center rounded-lg px-2 text-sm text-primary underline-offset-4 hover:underline [&::-webkit-details-marker]:hidden">
        Account
      </summary>
      <AccountMenuPanel pathname={pathname} />
    </details>
  );
}
