"use client";

import { BarChart3, Home, Landmark, List, WalletCards } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { bookNav, isNavActive } from "./nav";

const icons = {
  Home,
  Activity: List,
  Accounts: Landmark,
  Plan: WalletCards,
  History: BarChart3,
} as const;

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-border bg-card px-4 py-6 md:flex">
      <Link href="/" className="font-serif text-3xl tracking-tight text-primary">
        Dollas
      </Link>
      <p className="mt-1 text-xs text-muted-foreground">One pile of dollas.</p>
      <nav aria-label="Books" className="mt-8">
        <ul className="space-y-1">
          {bookNav.map((item) => {
            const Icon = icons[item.label];
            const active = isNavActive(pathname, item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm ${active ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                >
                  <Icon aria-hidden="true" className="size-4" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
