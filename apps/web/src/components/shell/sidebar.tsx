"use client";

import { BarChart3, Home, Landmark, List, Repeat, Settings, Tags, Users, WalletCards } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { desktopNav, isNavActive } from "./nav";

const icons = {
  Home,
  Activity: List,
  Accounts: Landmark,
  Categories: Tags,
  Plan: WalletCards,
  Recurring: Repeat,
  History: BarChart3,
  Household: Users,
  Settings,
} as const;

export function DesktopNav({ pathname }: { pathname: string }) {
  return (
    <nav aria-label="Main" className="mt-8">
      <ul className="space-y-1">
        {desktopNav.map((item) => {
          const Icon = icons[item.label];
          const active = isNavActive(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-11 items-center gap-3 rounded-full border-2 px-3 font-heading text-base font-bold transition-[background-color,box-shadow] duration-(--motion-fast) ease-(--ease-out) ${active ? "border-foreground bg-amber text-foreground shadow-press" : "border-transparent hover:bg-secondary"}`}
              >
                <span aria-hidden="true" className="inline-grid size-8 shrink-0 place-items-center rounded-full border-2 border-foreground bg-white"><Icon className="size-4" /></span>
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r-2 border-foreground bg-card px-4 py-6 md:flex">
      <Link href="/" className="inline-flex items-center gap-2.5 font-heading text-3xl font-extrabold tracking-tight text-foreground">
        <span aria-hidden="true" className="inline-grid size-9 shrink-0 place-items-center rounded-full border-2 border-foreground bg-primary text-primary-foreground">
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><circle cx="10" cy="14" r="5" /><path d="M15 4v15" /></svg>
        </span>
        dollas
      </Link>
      <p className="mt-1 text-xs text-muted-foreground">One household, two logins.</p>
      <DesktopNav pathname={pathname} />
    </aside>
  );
}
