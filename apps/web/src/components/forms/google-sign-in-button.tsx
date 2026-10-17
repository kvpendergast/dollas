"use client";

import { Button } from "@/components/ui/button";

export function GoogleSignInButton({ enabled, onSignIn }: { enabled: boolean; onSignIn: () => void }) {
  if (!enabled) return null;
  return (
    <Button type="button" variant="outline" className="w-full" onClick={onSignIn}>
      Continue with Google
    </Button>
  );
}
