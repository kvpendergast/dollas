import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const points = [
  "One household, separate logins. Nobody shares a password.",
  "A look ahead at the month, labeled as an estimate.",
];

export function Landing() {
  return (
    <main className="relative mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center overflow-hidden px-6 py-16">
      {/* SVG-only decoration, hidden on phones and never behind text blocks. */}
      <svg aria-hidden="true" viewBox="0 0 120 120" className="pointer-events-none absolute top-10 right-0 hidden size-28 sm:block">
        <circle cx="60" cy="60" r="44" fill="var(--confetti-amber)" stroke="var(--foreground)" strokeWidth="3" />
        <path d="M22 100 L50 100" stroke="var(--foreground)" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <svg aria-hidden="true" viewBox="0 0 120 120" className="pointer-events-none absolute right-10 bottom-16 hidden size-20 sm:block">
        <rect x="14" y="14" width="92" height="92" rx="10" fill="var(--confetti-pink)" stroke="var(--foreground)" strokeWidth="3" transform="rotate(12 60 60)" />
      </svg>
      <p className="inline-flex items-center gap-3 font-heading text-5xl font-extrabold tracking-tight">
        <span aria-hidden="true" className="inline-grid size-12 place-items-center rounded-full border-2 border-foreground bg-primary text-primary-foreground">
          <svg viewBox="0 0 24 24" className="size-7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><circle cx="10" cy="14" r="5" /><path d="M15 4v15" /></svg>
        </span>
        dollas
      </p>
      <p className="mt-3 text-sm text-muted-foreground">money for one household</p>
      <h1 className="mt-6 font-heading text-4xl tracking-tight md:text-5xl">
        <span className="bg-[linear-gradient(transparent_62%,var(--confetti-amber)_62%_92%,transparent_92%)]">Two logins. One household.</span>
      </h1>
      <p className="mt-4 max-w-xl text-base leading-relaxed text-muted-foreground">
        You and your person each sign in. The household stays shared, and they run on your own computer.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/sign-in" className={cn(buttonVariants(), "px-6")}>
          Sign in
        </Link>
        <Link href="/sign-up" className={cn(buttonVariants({ variant: "outline" }), "px-6")}>
          Create a login
        </Link>
      </div>
      <ul className="mt-10 space-y-3 text-sm">
        {points.map((point) => (
          <li key={point} className="flex gap-3">
            <span aria-hidden="true" className="mt-1 size-3 shrink-0 rounded-full border-2 border-foreground bg-amber" />
            <span>{point}</span>
          </li>
        ))}
      </ul>
      <p className="mt-16 text-xs text-muted-foreground">Open source. Your deploy. Your keys.</p>
    </main>
  );
}
