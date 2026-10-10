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
      className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
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
                className={`dl-transition flex min-h-14 flex-col items-center justify-center gap-1 px-0.5 text-xs ${active ? "text-primary" : "text-muted-foreground"}`}
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

export function PhoneNav() {
  const pathname = usePathname();
  return <PhoneTabBar pathname={pathname} />;
}
