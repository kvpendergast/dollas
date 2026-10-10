"use client";

import { LAST_OWNER_MESSAGE, type HouseholdRole, type SignInMethod } from "@dollas/domain";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EMAIL_CHANGE_HINT, GOOGLE_PASSWORD_MESSAGE, NO_PASSWORD_MESSAGE } from "@/slices/settings/copy";
import {
  changeEmailAction,
  changePasswordAction,
  deleteHouseholdAction,
  leaveHouseholdAction,
  transferOwnershipAction,
  updateNameAction,
  type SettingsFormState,
} from "@/slices/settings/actions";

const initial: SettingsFormState = { error: "" };

function FieldError({ message }: { message: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm text-over">
      {message}
    </p>
  );
}

function FieldNotice({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="status" className="text-sm text-income">
      {message}
    </p>
  );
}

export function passwordSectionCopy(method: SignInMethod): string | null {
  if (method === "google") return GOOGLE_PASSWORD_MESSAGE;
  if (method === "none") return NO_PASSWORD_MESSAGE;
  return null;
}

export function leaveHouseholdCopy(lastOwner: boolean, householdName: string): { title: string; body: string } {
  if (lastOwner) return { title: "You are the last owner", body: LAST_OWNER_MESSAGE };
  return {
    title: `Leave ${householdName}?`,
    body: "You will lose access to this household. Your login stays yours.",
  };
}

export function NameForm({ name }: { name: string }) {
  const [state, action, pending] = useActionState(updateNameAction, initial);
  return (
    <form action={action} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="settings-name">Name</Label>
        <Input id="settings-name" name="name" autoComplete="name" defaultValue={name} required />
      </div>
      <FieldError message={state.error} />
      <FieldNotice message={state.notice} />
      <Button type="submit" className="h-10" disabled={pending}>
        {pending ? "Saving" : "Save name"}
      </Button>
    </form>
  );
}

export function EmailForm({ email }: { email: string }) {
  const [state, action, pending] = useActionState(changeEmailAction, initial);
  return (
    <form action={action} className="space-y-3">
      <p className="text-sm">
        Current email <span className="font-medium">{email}</span>
      </p>
      <div className="space-y-1.5">
        <Label htmlFor="settings-email">New email</Label>
        <Input id="settings-email" name="email" type="email" autoComplete="email" required />
      </div>
      <p className="text-sm text-muted-foreground">{EMAIL_CHANGE_HINT}</p>
      <FieldError message={state.error} />
      <FieldNotice message={state.notice} />
      <Button type="submit" className="h-10" disabled={pending}>
        {pending ? "Sending link" : "Send confirmation link"}
      </Button>
    </form>
  );
}

export function PasswordSection({ method }: { method: SignInMethod }) {
  const copy = passwordSectionCopy(method);
  if (copy) return <p>{copy}</p>;
  return <PasswordForm />;
}

function PasswordForm() {
  const [state, action, pending] = useActionState(changePasswordAction, initial);
  return (
    <form action={action} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="settings-current-password">Current password</Label>
        <Input id="settings-current-password" name="currentPassword" type="password" autoComplete="current-password" required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="settings-new-password">New password</Label>
        <Input id="settings-new-password" name="newPassword" type="password" autoComplete="new-password" minLength={8} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="settings-confirm-password">Confirm new password</Label>
        <Input id="settings-confirm-password" name="confirm" type="password" autoComplete="new-password" minLength={8} required />
      </div>
      <FieldError message={state.error} />
      <FieldNotice message={state.notice} />
      <Button type="submit" className="h-10" disabled={pending}>
        {pending ? "Changing" : "Change password"}
      </Button>
    </form>
  );
}

export function TransferForm({ members }: { members: { userId: string; name: string; role: HouseholdRole }[] }) {
  const candidates = members.filter((member) => member.role !== "owner");
  const [state, action, pending] = useActionState(transferOwnershipAction, initial);
  if (candidates.length === 0) {
    return <p className="text-sm text-muted-foreground">Invite someone before you can hand this household off.</p>;
  }
  return (
    <form action={action} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="settings-owner">Hand ownership to</Label>
        <select
          id="settings-owner"
          name="memberId"
          className="h-10 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm"
          defaultValue={candidates[0]?.userId}
        >
          {candidates.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.name}
            </option>
          ))}
        </select>
      </div>
      <FieldError message={state.error} />
      <FieldNotice message={state.notice} />
      <Button type="submit" variant="outline" className="h-10" disabled={pending}>
        {pending ? "Handing off" : "Hand off ownership"}
      </Button>
    </form>
  );
}

export function LeaveHouseholdDialog({ lastOwner, householdName }: { lastOwner: boolean; householdName: string }) {
  const copy = leaveHouseholdCopy(lastOwner, householdName);
  const [state, action, pending] = useActionState(leaveHouseholdAction, initial);
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" className="h-10">
          Leave household
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.body}</DialogDescription>
        </DialogHeader>
        {lastOwner ? (
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" className="h-10">
                Close
              </Button>
            </DialogClose>
          </DialogFooter>
        ) : (
          <form action={action} className="space-y-3">
            <FieldError message={state.error} />
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" className="h-10">
                  Stay
                </Button>
              </DialogClose>
              <Button type="submit" variant="destructive" className="h-10" disabled={pending}>
                {pending ? "Leaving" : "Leave household"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function DeleteHouseholdDialog({ householdName }: { householdName: string }) {
  const [state, action, pending] = useActionState(deleteHouseholdAction, initial);
  const [typed, setTyped] = useState("");
  const [open, setOpen] = useState(false);
  const matches = typed.trim() === householdName.trim();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="destructive" className="h-10">
          Delete household
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {householdName}?</DialogTitle>
          <DialogDescription>
            This removes the household and everything in it. Type {householdName} to confirm. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <form action={action} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="settings-delete-name">Household name</Label>
            <Input
              id="settings-delete-name"
              name="confirmation"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
            />
          </div>
          <FieldError message={state.error} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" className="h-10">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" variant="destructive" className="h-10" disabled={pending || !matches}>
              {pending ? "Deleting" : "Delete household"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
