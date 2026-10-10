"use client";

import { useEffect, useRef } from "react";
import { successMessage, toast } from "./toast-store";

/**
 * Toast once each time a form action comes back without an error. Every
 * useActionState result is a new object, so the effect runs once per submit.
 */
export function useActionToast<S extends { error?: string; notice?: string; message?: string }>(
  state: S,
  message: string | ((state: S) => string | null | undefined),
) {
  const initial = useRef(state);
  const latest = useRef(message);
  useEffect(() => {
    latest.current = message;
  });
  useEffect(() => {
    const text = successMessage(initial.current, state, latest.current);
    if (text) toast(text);
  }, [state]);
}
