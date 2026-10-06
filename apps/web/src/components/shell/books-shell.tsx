import Link from "next/link";
import { signOutAction } from "@/slices/auth/actions";
import { AccountMenu } from "./account-menu";
import { PhoneNav } from "./phone-nav";
import { Sidebar } from "./sidebar";

export function BooksShell({
  householdName,
  children,
}: {
  householdName: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-full bg-background">
      <div className="mx-auto flex min-h-full max-w-6xl">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-4 md:px-8">
            <div>
              <p className="font-serif text-2xl leading-none text-primary md:hidden">dollas</p>
              <p className="text-sm text-muted-foreground">{householdName}</p>
            </div>
            <div className="flex items-center gap-3 text-sm">
              <AccountMenu />
              <Link href="/household" className="text-primary underline-offset-4 hover:underline">
                Invite
              </Link>
              <form action={signOutAction}>
                <button type="submit" className="text-muted-foreground hover:text-foreground">
                  Sign out
                </button>
              </form>
            </div>
          </header>
          <main className="flex-1 px-4 pt-6 pb-24 md:px-8 md:pb-12">{children}</main>
        </div>
      </div>
      <PhoneNav />
    </div>
  );
}
