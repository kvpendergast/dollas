import Link from "next/link";

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-16">
      <Link href="/" className="inline-flex items-center gap-3 font-heading text-5xl font-extrabold tracking-tight text-foreground">
        <span aria-hidden="true" className="inline-grid size-11 place-items-center rounded-full border-2 border-foreground bg-primary text-primary-foreground">
          <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><circle cx="10" cy="14" r="5" /><path d="M15 4v15" /></svg>
        </span>
        dollas
      </Link>
      <p className="mt-2 text-sm text-muted-foreground">money for one household</p>
      <div className="mt-8">{children}</div>
      <p className="mt-8 text-xs text-muted-foreground">Open source. Your deploy. Your keys.</p>
    </main>
  );
}
