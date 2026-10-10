"use client";

import { Check } from "lucide-react";
import { useEffect, useRef } from "react";

const KEY = "dollas:checklist-seen";

function readSeen(): Record<string, boolean> {
  try {
    return JSON.parse(window.sessionStorage.getItem(KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

/**
 * A checklist step's mark. A step usually completes on another page, so the
 * mark remembers what it last showed (session storage) and plays the tick
 * once when it comes back done. Already-done steps stay still.
 */
export function ChecklistMark({ id, done }: { id: string; done: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const seen = readSeen();
    if (done && seen[id] === false) {
      const node = ref.current;
      node?.classList.remove("dl-tick");
      void node?.offsetWidth;
      node?.classList.add("dl-tick");
    }
    try {
      window.sessionStorage.setItem(KEY, JSON.stringify({ ...seen, [id]: done }));
    } catch {
      // Private mode: no tick memory, no harm.
    }
  }, [id, done]);
  return done ? (
    <span
      ref={ref}
      data-mark="done"
      className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
      aria-hidden="true"
    >
      <Check className="size-3.5" strokeWidth={3} />
    </span>
  ) : (
    <span ref={ref} data-mark="todo" className="mt-0.5 size-5 shrink-0 rounded-full border-2 border-border" aria-hidden="true" />
  );
}
