import Link from "next/link";

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-16">
      <Link href="/" className="font-serif text-5xl tracking-tight text-primary">
        dollas
      </Link>
      <p className="mt-2 text-sm text-muted-foreground">money for one household</p>
      <div className="mt-8">{children}</div>
      <p className="mt-8 text-xs text-muted-foreground">Open source. Your deploy. Your keys.</p>
    </main>
  );
}
