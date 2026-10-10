"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    void fetch("/api/log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: error.message, digest: error.digest ?? "" }),
    });
  }, [error]);

  return (
    <main className="mx-auto flex min-h-full max-w-lg flex-col justify-center gap-4 px-6 py-16">
      <h1 className="font-serif text-4xl text-primary">That page didn&apos;t open</h1>
      <p className="text-muted-foreground">The error was logged.</p>
      <Button type="button" className="h-10 w-fit" onClick={() => reset()}>
        Try again
      </Button>
    </main>
  );
}
