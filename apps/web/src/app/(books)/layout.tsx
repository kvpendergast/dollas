import { BooksShell } from "@/components/shell/books-shell";
import { getActorContext, requireBooks } from "@/slices/access/guard";
import { getOnboardingStatus } from "@/slices/onboarding/service";

export const dynamic = "force-dynamic";

export default async function BooksLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getActorContext();
  if (!ctx) return children;
  const books = await requireBooks();
  const setup = await getOnboardingStatus(books);
  // Same rule as the checklist: the invite shows once the first account exists (or a partner already joined).
  const showInvite = !setup.ok || setup.value.waiting.every((row) => row.id !== "invite");
  return (
    <BooksShell householdName={books.householdName} showInvite={showInvite}>
      {children}
    </BooksShell>
  );
}
