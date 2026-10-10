import { err, ok, type Result } from "neverthrow";
import { isAuthEmail, normalizeAuthEmail } from "../auth/recovery";
import { InviteError, type InviteFailureReason } from "../errors";
import type { HouseholdRole } from "./access";

/**
 * Household invites. The owner invites one email address. The link carries a
 * random-looking token; the database stores only its SHA-256 hash, so a copy of
 * the table cannot be turned back into a working link. The token is an HMAC of
 * the invite id under the server secret, which is how an owner can copy the
 * same link again later without the raw token ever being stored.
 *
 * An invite works once, for seven days, and only for a login whose verified
 * email matches the invited address. The SQL functions in
 * 0022_household_invite_access repeat every rule here and use the same messages.
 */
export const INVITE_TTL_DAYS = 7;
export const INVITE_TTL_MS = INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;

export const INVITE_MESSAGES = {
  not_owner: "Only an owner can invite or revoke.",
  invalid_email: "Enter the email address your person signs in with.",
  already_member: "That person is already in this household.",
  already_invited: "That email already has an open invite. Copy its link or revoke it first.",
  not_found: "That invite link is not valid. Ask for a new one.",
  not_pending: "That invite is no longer open.",
  revoked: "This invite was revoked. Ask the owner for a new one.",
  expired: "This invite expired. Ask the owner for a new one.",
  used: "This invite was already used. Ask the owner for a new one.",
  wrong_email: "This invite is for a different email. Sign in with the address it was sent to.",
  unverified: "Verify your email before joining a household.",
  other_household:
    "You are already in another household. Leave it in Settings first, then open this link again.",
} as const satisfies Record<InviteFailureReason, string>;

export function inviteError(reason: InviteFailureReason): InviteError {
  return new InviteError(reason, INVITE_MESSAGES[reason]);
}

/** Matches a message raised by the SQL functions back to its typed error. */
/**
 * The database functions from migration 0022 still raise the wording from
 * before PEN-204's one-name pass. Members never see it: it maps to the
 * current message here.
 */
const DATABASE_WORDING: Partial<Record<InviteFailureReason, string>> = {
  // copy-terms-ignore: matched against database errors, never shown.
  already_member: "That person is already in these books.",
  // copy-terms-ignore: matched against database errors, never shown.
  other_household: "You already keep books in another household.",
};

export function inviteErrorFromText(text: string): InviteError | null {
  const reasons = Object.keys(INVITE_MESSAGES) as InviteFailureReason[];
  const reason =
    reasons.find((key) => text.includes(INVITE_MESSAGES[key])) ??
    reasons.find((key) => {
      const legacy = DATABASE_WORDING[key];
      return legacy != null && text.includes(legacy);
    });
  return reason ? inviteError(reason) : null;
}

export type InviteState = "pending" | "expired" | "revoked" | "used";

export type InviteTimes = {
  expiresAt: Date;
  revokedAt: Date | null;
  acceptedAt: Date | null;
};

/** Revoked and used win over expired, so the message names what actually happened. */
export function inviteState(invite: InviteTimes, now: Date): InviteState {
  if (invite.revokedAt) return "revoked";
  if (invite.acceptedAt) return "used";
  if (invite.expiresAt.getTime() <= now.getTime()) return "expired";
  return "pending";
}

export function inviteExpiresAt(now: Date): Date {
  return new Date(now.getTime() + INVITE_TTL_MS);
}

export type InviteSeat = {
  userId: string;
  email: string;
  role: HouseholdRole;
};

export type PendingInviteRef = {
  id: string;
  email: string;
} & InviteTimes;

/** Owner-only. Returns the normalized address to invite. */
export function planCreateInvite(input: {
  actorUserId: string;
  seats: readonly InviteSeat[];
  invites: readonly PendingInviteRef[];
  email: string;
  now: Date;
}): Result<{ email: string }, InviteError> {
  const me = input.seats.find((seat) => seat.userId === input.actorUserId);
  if (me?.role !== "owner") return err(inviteError("not_owner"));
  const email = normalizeAuthEmail(input.email);
  if (!isAuthEmail(email)) return err(inviteError("invalid_email"));
  if (input.seats.some((seat) => normalizeAuthEmail(seat.email) === email)) return err(inviteError("already_member"));
  const open = input.invites.some(
    (invite) => normalizeAuthEmail(invite.email) === email && inviteState(invite, input.now) === "pending",
  );
  if (open) return err(inviteError("already_invited"));
  return ok({ email });
}

/** Owner-only, and only while the invite is still open. */
export function planRevokeInvite(input: {
  actorRole: HouseholdRole | null;
  invite: InviteTimes | null;
  now: Date;
}): Result<void, InviteError> {
  if (input.actorRole !== "owner") return err(inviteError("not_owner"));
  if (!input.invite) return err(inviteError("not_found"));
  if (inviteState(input.invite, input.now) !== "pending") return err(inviteError("not_pending"));
  return ok(undefined);
}

export type InviteAcceptance = {
  invite: (InviteTimes & { email: string; householdId: string; acceptedBy: string | null }) | null;
  user: { id: string; email: string; verified: boolean };
  /** Households this login already belongs to. */
  memberOf: readonly string[];
  now: Date;
};

/**
 * Decides whether this login can join. `joined` means they already belong to
 * the invited household (for example a second click on the same link), which
 * the accept page treats as done rather than as an error.
 */
export function decideInviteAcceptance(
  input: InviteAcceptance,
): Result<{ householdId: string; joined: boolean }, InviteError> {
  const invite = input.invite;
  if (!invite) return err(inviteError("not_found"));
  if (input.memberOf.includes(invite.householdId)) return ok({ householdId: invite.householdId, joined: true });
  const state = inviteState(invite, input.now);
  if (state !== "pending") return err(inviteError(state));
  if (!input.user.verified) return err(inviteError("unverified"));
  if (normalizeAuthEmail(input.user.email) !== normalizeAuthEmail(invite.email)) return err(inviteError("wrong_email"));
  if (input.memberOf.length > 0) return err(inviteError("other_household"));
  return ok({ householdId: invite.householdId, joined: false });
}

/** "ada@example.com" becomes "a••@example.com". Shown to someone holding the link. */
export function maskInviteEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "••";
  const local = email.slice(0, at);
  return `${local[0]}${"•".repeat(Math.min(Math.max(local.length - 1, 2), 6))}${email.slice(at)}`;
}

/** 32 bytes of HMAC-SHA-256, base64url without padding. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const INVITE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// copy-terms-ignore: hashing label, changing it would invalidate every open invite.
const TOKEN_LABEL = "dollas household invite v1:";

export function isInviteToken(value: string): boolean {
  return TOKEN_SHAPE.test(value);
}

type Subtle = {
  importKey(
    format: "raw",
    key: Uint8Array,
    algorithm: { name: "HMAC"; hash: "SHA-256" },
    extractable: false,
    usages: readonly ["sign"],
  ): Promise<unknown>;
  sign(algorithm: "HMAC", key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
};

function subtle(): Subtle {
  return (globalThis as unknown as { crypto: { subtle: Subtle } }).crypto.subtle;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Link token for one invite. Same secret and id give the same token. */
export async function deriveInviteToken(secret: string, inviteId: string): Promise<string> {
  if (secret.length < 16) throw new Error("Invite signing secret is too short");
  if (!INVITE_ID.test(inviteId)) throw new Error("Invite id must be a uuid");
  const encoder = new TextEncoder();
  const key = await subtle().importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await subtle().sign("HMAC", key, encoder.encode(`${TOKEN_LABEL}${inviteId.toLowerCase()}`));
  return base64url(new Uint8Array(mac));
}

/** What the database stores and looks up: lowercase hex SHA-256 of the token. */
export async function hashInviteToken(token: string): Promise<string> {
  const digest = await subtle().digest("SHA-256", new TextEncoder().encode(token));
  return hex(new Uint8Array(digest));
}

/** The token from a pasted invite link (or a bare token), or null. */
export function inviteTokenFromPaste(raw: string): string | null {
  const value = raw.trim();
  if (isInviteToken(value)) return value;
  const match = /\/invite\/([A-Za-z0-9_-]{43})(?:[/?#]|$)/.exec(value);
  return match ? match[1] : null;
}

export function inviteLinkPath(token: string): string {
  return `/invite/${token}`;
}
