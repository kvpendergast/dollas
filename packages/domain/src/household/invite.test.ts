import { describe, expect, it } from "vitest";
import { InviteError } from "../errors";
import { memberFacingMessage } from "../setup/config";
import {
  INVITE_MESSAGES,
  INVITE_TTL_DAYS,
  decideInviteAcceptance,
  deriveInviteToken,
  hashInviteToken,
  inviteErrorFromText,
  inviteExpiresAt,
  inviteState,
  isInviteToken,
  maskInviteEmail,
  planCreateInvite,
  planRevokeInvite,
  type InviteSeat,
} from "./invite";

const now = new Date("2026-10-10T15:00:00Z");
const later = new Date("2026-10-17T15:00:00Z");
const secret = "test-secret-at-least-sixteen-chars";
const inviteId = crypto.randomUUID();
const otherInviteId = crypto.randomUUID();
const house = "house-a";

const seats: InviteSeat[] = [
  { userId: "ada", email: "ada@example.com", role: "owner" },
  { userId: "bea", email: "Bea@Example.com", role: "member" },
];

const open = { expiresAt: later, revokedAt: null, acceptedAt: null };

describe("invite tokens", () => {
  it("derives the same 43-character token for the same invite, and a different one per invite or secret", async () => {
    const a = await deriveInviteToken(secret, inviteId);
    const again = await deriveInviteToken(secret, inviteId.toUpperCase());
    const other = await deriveInviteToken(secret, otherInviteId);
    const otherSecret = await deriveInviteToken(`${secret}!`, inviteId);
    expect(isInviteToken(a)).toBe(true);
    expect(again).toBe(a);
    expect(other).not.toBe(a);
    expect(otherSecret).not.toBe(a);
  });

  it("stores a SHA-256 hash that is not the token and cannot be confused with it", async () => {
    const token = await deriveInviteToken(secret, inviteId);
    const hash = await hashInviteToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(await hashInviteToken(token)).toBe(hash);
    expect(await hashInviteToken(`${token}x`)).not.toBe(hash);
  });

  it("refuses a short secret or a non-uuid id", async () => {
    await expect(deriveInviteToken("short", inviteId)).rejects.toThrow();
    await expect(deriveInviteToken(secret, "not-a-uuid")).rejects.toThrow();
  });

  it("rejects malformed tokens", () => {
    expect(isInviteToken("abc")).toBe(false);
    expect(isInviteToken("a".repeat(43))).toBe(true);
    expect(isInviteToken(`${"a".repeat(42)}/`)).toBe(false);
  });
});

describe("invite state and expiry", () => {
  it("expires seven days after it is made", () => {
    expect(INVITE_TTL_DAYS).toBe(7);
    expect(inviteExpiresAt(now).toISOString()).toBe(later.toISOString());
    expect(inviteState({ ...open, expiresAt: inviteExpiresAt(now) }, now)).toBe("pending");
    expect(inviteState({ ...open, expiresAt: inviteExpiresAt(now) }, later)).toBe("expired");
  });

  it("names revoke and use before expiry", () => {
    const past = new Date("2026-10-01T00:00:00Z");
    expect(inviteState({ expiresAt: past, revokedAt: now, acceptedAt: null }, now)).toBe("revoked");
    expect(inviteState({ expiresAt: past, revokedAt: null, acceptedAt: now }, now)).toBe("used");
  });
});

describe("creating an invite", () => {
  it("lets the owner invite a new address, normalized", () => {
    const planned = planCreateInvite({ actorUserId: "ada", seats, invites: [], email: "  Cam@Example.COM ", now });
    expect(planned._unsafeUnwrap()).toEqual({ email: "cam@example.com" });
  });

  it("is owner-only", () => {
    const planned = planCreateInvite({ actorUserId: "bea", seats, invites: [], email: "cam@example.com", now });
    expect(planned._unsafeUnwrapErr().reason).toBe("not_owner");
    const outsider = planCreateInvite({ actorUserId: "zed", seats, invites: [], email: "cam@example.com", now });
    expect(outsider._unsafeUnwrapErr().reason).toBe("not_owner");
  });

  it("refuses a bad address, an existing member, and a second open invite", () => {
    expect(planCreateInvite({ actorUserId: "ada", seats, invites: [], email: "nope", now })._unsafeUnwrapErr().reason).toBe(
      "invalid_email",
    );
    expect(
      planCreateInvite({ actorUserId: "ada", seats, invites: [], email: "bea@example.com", now })._unsafeUnwrapErr().reason,
    ).toBe("already_member");
    const invites = [{ id: "i1", email: "cam@example.com", ...open }];
    expect(
      planCreateInvite({ actorUserId: "ada", seats, invites, email: "CAM@example.com", now })._unsafeUnwrapErr().reason,
    ).toBe("already_invited");
  });

  it("allows a fresh invite once the old one expired or was revoked", () => {
    const invites = [
      { id: "i1", email: "cam@example.com", expiresAt: now, revokedAt: null, acceptedAt: null },
      { id: "i2", email: "cam@example.com", expiresAt: later, revokedAt: now, acceptedAt: null },
    ];
    expect(planCreateInvite({ actorUserId: "ada", seats, invites, email: "cam@example.com", now }).isOk()).toBe(true);
  });
});

describe("revoking an invite", () => {
  it("is owner-only and only while open", () => {
    expect(planRevokeInvite({ actorRole: "owner", invite: open, now }).isOk()).toBe(true);
    expect(planRevokeInvite({ actorRole: "member", invite: open, now })._unsafeUnwrapErr().reason).toBe("not_owner");
    expect(planRevokeInvite({ actorRole: null, invite: open, now })._unsafeUnwrapErr().reason).toBe("not_owner");
    expect(planRevokeInvite({ actorRole: "owner", invite: null, now })._unsafeUnwrapErr().reason).toBe("not_found");
    expect(
      planRevokeInvite({ actorRole: "owner", invite: { ...open, acceptedAt: now }, now })._unsafeUnwrapErr().reason,
    ).toBe("not_pending");
  });
});

describe("accepting an invite", () => {
  const invite = { ...open, email: "cam@example.com", householdId: house, acceptedBy: null };
  const cam = { id: "cam", email: "Cam@example.com", verified: true };

  it("joins when the verified email matches", () => {
    const result = decideInviteAcceptance({ invite, user: cam, memberOf: [], now });
    expect(result._unsafeUnwrap()).toEqual({ householdId: house, joined: false });
  });

  it("is bound to the invited email", () => {
    const result = decideInviteAcceptance({ invite, user: { ...cam, email: "dee@example.com" }, memberOf: [], now });
    expect(result._unsafeUnwrapErr().reason).toBe("wrong_email");
  });

  it("needs a verified email", () => {
    const result = decideInviteAcceptance({ invite, user: { ...cam, verified: false }, memberOf: [], now });
    expect(result._unsafeUnwrapErr().reason).toBe("unverified");
  });

  it("works once, and not after revoke or expiry", () => {
    const used = decideInviteAcceptance({ invite: { ...invite, acceptedAt: now, acceptedBy: "x" }, user: cam, memberOf: [], now });
    expect(used._unsafeUnwrapErr().reason).toBe("used");
    const revoked = decideInviteAcceptance({ invite: { ...invite, revokedAt: now }, user: cam, memberOf: [], now });
    expect(revoked._unsafeUnwrapErr().reason).toBe("revoked");
    const expired = decideInviteAcceptance({ invite, user: cam, memberOf: [], now: later });
    expect(expired._unsafeUnwrapErr().reason).toBe("expired");
  });

  it("treats an existing member as already joined, and refuses a second household", () => {
    const again = decideInviteAcceptance({ invite: { ...invite, acceptedAt: now, acceptedBy: "cam" }, user: cam, memberOf: [house], now });
    expect(again._unsafeUnwrap()).toEqual({ householdId: house, joined: true });
    const elsewhere = decideInviteAcceptance({ invite, user: cam, memberOf: ["house-b"], now });
    expect(elsewhere._unsafeUnwrapErr().reason).toBe("other_household");
  });

  it("reports a missing invite plainly", () => {
    const result = decideInviteAcceptance({ invite: null, user: cam, memberOf: [], now });
    expect(result._unsafeUnwrapErr().reason).toBe("not_found");
  });
});

describe("member-facing copy", () => {
  it("shows the invite message and maps SQL text back to a typed error", () => {
    const error = inviteErrorFromText(`ERROR: ${INVITE_MESSAGES.wrong_email}`);
    expect(error).toBeInstanceOf(InviteError);
    expect(error?.reason).toBe("wrong_email");
    expect(memberFacingMessage(error, "fallback")).toBe(INVITE_MESSAGES.wrong_email);
    expect(inviteErrorFromText("relation does not exist")).toBeNull();
    for (const message of Object.values(INVITE_MESSAGES)) {
      expect(message).not.toMatch(/[A-Z_]{4,}=|RESEND|DATABASE|SECRET/);
    }
  });

  it("masks the invited address", () => {
    expect(maskInviteEmail("ada@example.com")).toBe("a••@example.com");
    expect(maskInviteEmail("a@example.com")).toBe("a••@example.com");
    expect(maskInviteEmail("bartholomew@example.com")).toBe("b••••••@example.com");
  });
});
