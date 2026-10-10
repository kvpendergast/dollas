"use client";

import { Check, X } from "lucide-react";
import { useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { dismissToast, getServerToasts, getToasts, subscribeToasts } from "@/lib/toast-store";

/**
 * Toasts sit above the phone tab bar (and its safe area), bottom right on
 * desktop. The live region is always mounted so screen readers announce each
 * new message politely.
 */
export function Toaster() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getServerToasts);
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(5rem+env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 px-4 md:inset-x-auto md:right-6 md:bottom-6 md:items-end"
    >
      {toasts.map((item) => (
        <div
          key={item.id}
          data-toast={item.tone}
          className={cn(
            "pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-xl bg-foreground px-4 py-3 text-sm text-background shadow-lg",
            item.leaving ? "dl-toast-out" : "dl-toast-in",
          )}
        >
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground" aria-hidden="true">
            <Check className="size-3.5" strokeWidth={3} />
          </span>
          <p className="min-w-0 flex-1">{item.message}</p>
          <button
            type="button"
            onClick={() => dismissToast(item.id)}
            className="-mr-2 flex size-11 shrink-0 items-center justify-center rounded-lg text-background/70 hover:text-background focus-visible:ring-2 focus-visible:ring-background/60 focus-visible:outline-none"
          >
            <X className="size-4" aria-hidden="true" />
            <span className="sr-only">Dismiss</span>
          </button>
        </div>
      ))}
    </div>
  );
}
