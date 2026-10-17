"use client";

import { Settings, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { accountNav, isNavActive } from "./nav";

const icons = { Household: Users, Settings } as const;

/** Phone header menu (Dropdown Menu). Desktop uses the sidebar, so this stays off wider screens. */
export function AccountMenu() {
  const pathname = usePathname();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex min-h-11 cursor-pointer items-center rounded-full px-2 text-sm text-primary underline-offset-4 hover:underline focus-visible:shadow-focus md:hidden">
        Account
      </DropdownMenuTrigger>
      <DropdownMenuContent aria-label="Account">
        {accountNav.map((item) => {
          const Icon = icons[item.label];
          return (
            <DropdownMenuItem key={item.href} asChild aria-current={isNavActive(pathname, item.href) ? "page" : undefined}>
              <Link href={item.href}>
                <Icon aria-hidden="true" />
                {item.label}
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
