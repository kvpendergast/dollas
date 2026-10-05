"use client";

import { BarChart3, Home, Landmark, List, Tags, WalletCards } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { bookNav, isNavActive } from "./nav";

const icons = {
  Home,
  Activity: List,
  Accounts: Landmark,
  Categories: Tags,
  Plan: WalletCards,
  History: BarChart3,
} as const;

export function PhoneNav() {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Phone"
      className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-card/95 backdrop-blur md:hidden"
    >
      <ul className="grid grid-cols-6">
        {bookNav.map((item) => {
          const Icon = icons[item.label];
          const active = isNavActive(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center gap-1 px-1 py-2 text-[11px] ${active ? "text-primary" : "text-muted-foreground"}`}
              >
                <Icon aria-hidden="true" className="size-5" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
