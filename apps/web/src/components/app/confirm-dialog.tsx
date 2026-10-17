"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { FieldError } from "@/components/ui/field";

/**
 * ConfirmDialog: the one "are you sure?" pattern. Renders a Dialog whose body is a form posting
 * `action` (a server action wrapped in useActionState). `trigger` is the button that opens it.
 * Extra fields (hidden ids, a typed-name Input) go in `children`. Set `confirmDisabled` until the
 * user has done what is required. With no `action` it is an info dialog with only a Close button.
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  action,
  pending = false,
  error,
  confirmLabel,
  pendingLabel,
  cancelLabel = "Cancel",
  confirmDisabled = false,
  destructive = true,
  children,
}: {
  trigger: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: (formData: FormData) => void;
  pending?: boolean;
  error?: string;
  confirmLabel?: string;
  pendingLabel?: string;
  cancelLabel?: string;
  confirmDisabled?: boolean;
  destructive?: boolean;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {action ? (
          <form action={action} className="space-y-3">
            {children}
            <FieldError>{error}</FieldError>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  {cancelLabel}
                </Button>
              </DialogClose>
              <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={pending || confirmDisabled}>
                {pending ? (pendingLabel ?? confirmLabel) : confirmLabel}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {cancelLabel}
              </Button>
            </DialogClose>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
