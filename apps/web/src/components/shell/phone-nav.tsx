"use client";

import { BarChart3, Home, Landmark, List, Tags, WalletCards } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { bookNav, isPhoneTabActive } from "./nav";

const icons = {
  Home,
  Activity: List,
  Accounts: Landmark,
  Categories: Tags,
  Plan: WalletCards,
  History: BarChart3,
} as const;

export function PhoneTabBar({ pathname }: { pathname: string }) {
  return (
    <nav
      aria-label="Phone"
      className="fixed inset-x-0 bottom-0 z-20 border-t-2 border-foreground bg-card pb-(--safe-bottom) md:hidden"
    >
      <ul className="grid grid-cols-6">
        {bookNav.map((item) => {
          const Icon = icons[item.label];
          const active = isPhoneTabActive(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-14 flex-col items-center justify-center gap-0.5 px-0.5 text-xs font-bold ${active ? "text-foreground" : "text-muted-foreground"}`}
              >
                <span aria-hidden="true" className={`inline-grid size-8 place-items-center rounded-full border-2 transition-[background-color] duration-(--motion-fast) ${active ? "border-foreground bg-amber" : "border-transparent"}`}><Icon className="size-4" /></span>
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function PhoneNav() {
  const pathname = usePathname();
  return <PhoneTabBar pathname={pathname} />;
}
