import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const points = [
  "Same books, separate logins. Nobody shares a password.",
  "Categories that remember the coffee shop.",
  "A look ahead at the month, labeled as a guess.",
];

export function Landing() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-6 py-16">
      <p className="font-serif text-5xl tracking-tight text-primary">Dollas</p>
      <p className="mt-3 text-sm text-muted-foreground">household books</p>
      <h1 className="mt-6 font-serif text-4xl tracking-tight md:text-5xl">Two logins. One pile of dollas.</h1>
      <p className="mt-4 max-w-xl text-base leading-relaxed text-muted-foreground">
        You and your person each sign in. The books stay shared. A bank if you want one, a CSV if you don&apos;t.
        Dollas never asks for the bank password, and it runs on your own computer.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/sign-in" className={cn(buttonVariants(), "h-10 px-4")}>
          Sign in
        </Link>
        <Link href="/sign-in" className={cn(buttonVariants({ variant: "outline" }), "h-10 px-4")}>
          Open the books
        </Link>
      </div>
      <ul className="mt-10 space-y-3 text-sm">
        {points.map((point) => (
          <li key={point} className="flex gap-3">
            <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
            <span>{point}</span>
          </li>
        ))}
      </ul>
      <p className="mt-16 text-xs text-muted-foreground">Open source. Your deploy. Your keys.</p>
    </main>
  );
}
