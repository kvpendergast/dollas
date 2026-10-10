import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const points = [
  "One household, separate logins. Nobody shares a password.",
  "A look ahead at the month, labeled as an estimate.",
];

export function Landing() {
  return (
    <main className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-6 py-16">
      <p className="font-serif text-5xl tracking-tight text-primary">dollas</p>
      <p className="mt-3 text-sm text-muted-foreground">money for one household</p>
      <h1 className="mt-6 font-serif text-4xl tracking-tight md:text-5xl">Two logins. One household.</h1>
      <p className="mt-4 max-w-xl text-base leading-relaxed text-muted-foreground">
        You and your person each sign in. The household stays shared, and they run on your own computer.
      </p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/sign-in" className={cn(buttonVariants(), "h-10 px-4")}>
          Sign in
        </Link>
        <Link href="/sign-up" className={cn(buttonVariants({ variant: "outline" }), "h-10 px-4")}>
          Create a login
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
