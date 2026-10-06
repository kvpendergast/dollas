"use client";

import { Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { isNavActive, settingsNav } from "./nav";

export function AccountMenuPanel({ pathname }: { pathname: string }) {
  const active = isNavActive(pathname, settingsNav.href);
  return (
    <nav aria-label="Account" className="absolute right-0 z-30 mt-2 min-w-40 rounded-xl bg-card p-2 ring-1 ring-foreground/10">
      <Link
        href={settingsNav.href}
        aria-current={active ? "page" : undefined}
        className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${active ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
      >
        <Settings aria-hidden="true" className="size-4" />
        {settingsNav.label}
      </Link>
    </nav>
  );
}

/** Phone header menu. Desktop uses the sidebar, so this stays off wider screens. */
export function AccountMenu() {
  const pathname = usePathname();
  return (
    <details className="relative md:hidden">
      <summary className="cursor-pointer list-none rounded-lg px-2 py-1 text-sm text-primary underline-offset-4 hover:underline [&::-webkit-details-marker]:hidden">
        Account
      </summary>
      <AccountMenuPanel pathname={pathname} />
    </details>
  );
}
