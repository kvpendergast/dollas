import * as React from "react";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";

/**
 * UndoBar: a persistent status bar with one action (e.g. "Deleted Amazon. Undo"). Unlike a toast it
 * does not time out, because undo must stay reachable by keyboard and screen reader. Sits above the
 * phone tab bar. Pass `buttonRef` to move focus to the action.
 */
export function UndoBar({
  message,
  actionLabel,
  pendingLabel,
  pending,
  error,
  onAction,
  buttonRef,
}: {
  message: React.ReactNode;
  actionLabel: string;
  pendingLabel: string;
  pending?: boolean;
  error?: string;
  onAction: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <div
      role="status"
      className="dl-toast-in fixed inset-x-4 bottom-[calc(6rem+env(safe-area-inset-bottom))] z-30 mx-auto flex max-w-md flex-col gap-2 rounded-md border-2 border-foreground bg-card px-4 py-3 shadow-pop md:bottom-8"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm">{message}</p>
        <Button ref={buttonRef} type="button" variant="outline" disabled={pending} onClick={onAction}>
          {pending ? pendingLabel : actionLabel}
        </Button>
      </div>
      <FieldError>{error}</FieldError>
    </div>
  );
}
