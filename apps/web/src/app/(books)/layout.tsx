import { BooksShell } from "@/components/shell/books-shell";
import { getActorContext, requireBooks } from "@/slices/access/guard";

export const dynamic = "force-dynamic";

export default async function BooksLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getActorContext();
  if (!ctx) return children;
  const books = await requireBooks();
  return <BooksShell householdName={books.householdName}>{children}</BooksShell>;
}
