import { Button } from "@/components/ui/button";
import Link from "next/link";
import { signOutAction } from "@/slices/auth/actions";
import { AccountMenu } from "./account-menu";
import { PhoneNav } from "./phone-nav";
import { Sidebar } from "./sidebar";

export function BooksShell({
  householdName,
  showInvite,
  children,
}: {
  householdName: string;
  /** The invite is offered once the first account exists (PEN-204). */
  showInvite: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-full bg-background">
      <div className="flex min-h-full w-full">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between gap-3 border-b-2 border-foreground px-4 py-2 md:px-8 md:py-4">
            <div className="min-w-0">
              <p className="font-heading text-2xl leading-none font-extrabold md:hidden">dollas</p>
              <p className="truncate text-sm text-muted-foreground">{householdName}</p>
            </div>
            <div className="flex items-center gap-1 text-sm sm:gap-3">
              <AccountMenu />
              {showInvite ? (
                <Link href="/household#invite" className="flex min-h-11 items-center px-2 text-primary underline-offset-4 hover:underline">
                  Invite
                </Link>
              ) : null}
              <form action={signOutAction}>
                <Button type="submit" variant="ghost" className="px-2 font-sans font-medium text-muted-foreground hover:text-foreground">
                  Sign out
                </Button>
              </form>
            </div>
          </header>
          <main className="flex-1 px-4 pt-6 pb-(--offset-undo) md:px-8 md:pb-12">{children}</main>
        </div>
      </div>
      <PhoneNav />
    </div>
  );
}
