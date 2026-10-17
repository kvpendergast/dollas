"use client";

import { Check, X } from "lucide-react";
import { useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { dismissToast, getServerToasts, getToasts, subscribeToasts } from "@/lib/toast-store";

/**
 * Toasts sit above the phone tab bar (and its safe area), bottom right on
 * desktop. The live region is always mounted so screen readers announce each
 * new message politely.
 *
 * Why not shadcn Sonner (PEN-311 decision): Sonner adds a dependency and its own stylesheet and
 * positioning, so keeping the live region above the phone tab bar (--offset-toast) and under the
 * reduced-motion block means overriding most of it; our 4-second, 3-at-most store is ~100 lines,
 * token-styled, and covered by tests. Keep this until we need actions or promises in toasts.
 * The delete undo is not a toast: see app/undo-bar.tsx (it must not time out).
 */
export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getServerToasts);
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 bottom-(--offset-toast) z-[60] flex flex-col items-center gap-2 px-4 md:inset-x-auto md:right-6 md:bottom-6 md:items-end"
    >
      {toasts.map((item) => (
        <div
          key={item.id}
          data-toast={item.tone}
          className={cn(
            "pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-md border-2 border-foreground bg-card px-4 py-3 text-sm font-semibold text-foreground shadow-pop",
            item.leaving ? "dl-toast-out" : "dl-toast-in",
          )}
        >
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-foreground bg-mint text-foreground" aria-hidden="true">
            <Check className="size-3.5" strokeWidth={3} />
          </span>
          <p className="min-w-0 flex-1">{item.message}</p>
          <button
            type="button"
            onClick={() => dismissToast(item.id)}
            className="-mr-2 flex size-11 shrink-0 items-center justify-center rounded-full text-foreground hover:bg-amber focus-visible:shadow-focus focus-visible:outline-3 focus-visible:outline-ring"
          >
            <X className="size-4" aria-hidden="true" />
            <span className="sr-only">Dismiss</span>
          </button>
        </div>
      ))}
    </div>
  );
}
