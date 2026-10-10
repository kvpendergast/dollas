/**
 * A tiny toast store (PEN-208): no dependency. Success confirmations after a
 * save, add, edit, delete, or undo. Errors stay inline with the form, using
 * the member-facing message, so a failure is next to the field that caused it.
 */

export type ToastTone = "success" | "info";
export type Toast = { id: number; message: string; tone: ToastTone; leaving: boolean };

export const TOAST_MS = 4000;
export const TOAST_EXIT_MS = 160;
const MAX_TOASTS = 3;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getToasts(): readonly Toast[] {
  return toasts;
}

const EMPTY: readonly Toast[] = [];
export function getServerToasts(): readonly Toast[] {
  return EMPTY;
}

export function dismissToast(id: number) {
  const found = toasts.find((item) => item.id === id);
  if (!found || found.leaving) return;
  clearTimeout(timers.get(id));
  toasts = toasts.map((item) => (item.id === id ? { ...item, leaving: true } : item));
  emit();
  timers.set(
    id,
    setTimeout(() => {
      toasts = toasts.filter((item) => item.id !== id);
      timers.delete(id);
      emit();
    }, TOAST_EXIT_MS),
  );
}

/** Show a short confirmation. Returns its id. The same message twice in a row replaces the first. */
export function toast(message: string, tone: ToastTone = "success"): number {
  const text = message.trim();
  if (!text) return 0;
  for (const item of toasts) if (item.message === text && !item.leaving) dismissToast(item.id);
  const id = nextId++;
  toasts = [...toasts, { id, message: text, tone, leaving: false }].slice(-MAX_TOASTS);
  emit();
  timers.set(id, setTimeout(() => dismissToast(id), TOAST_MS));
  return id;
}

/** Tests only. */
export function resetToasts() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  toasts = [];
  emit();
}

/**
 * What to announce when an action's state changes: nothing for the initial
 * state or an error, otherwise the action's own notice or the fallback.
 */
export function successMessage<S extends { error?: string; notice?: string; message?: string }>(
  initial: S,
  state: S,
  message: string | ((state: S) => string | null | undefined),
): string | null {
  if (state === initial) return null;
  if (state.error) return null;
  const text = typeof message === "function" ? message(state) : message;
  return text && text.trim() ? text : null;
}
