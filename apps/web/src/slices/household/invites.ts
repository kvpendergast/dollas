import {
  DomainError,
  INVITE_TTL_DAYS,
  InviteError,
  decideInviteAcceptance,
  deriveInviteToken,
  hashInviteToken,
  hidesSetupDetail,
  inviteError,
  inviteErrorFromText,
  inviteLinkPath,
  isInviteToken,
  maskInviteEmail,
  memberFacingMessage,
  planCreateInvite,
  planRevokeInvite,
  type HouseholdRole,
  type InviteState,
  type MailDeliveryResult,
} from "@dollas/domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import { withActor } from "@/db/actor";
import type { AppDatabase } from "@/db/client";
import { getDb } from "@/db/client";
import { household, householdInvite, householdMember, user } from "@/db/schema";
import { serverSecret, siteOrigin } from "@/lib/server-secret";
import { logError, logInfo } from "@/lib/telemetry";
import { deliverHouseholdInviteEmail, inviteMailMode, type InviteMailMode } from "@/lib/verification-email";

/**
 * Household invite services.
 *
 * MCP-able (a page action and an MCP tool both call these):
 *   listHouseholdPeople, createHouseholdInvite, copyHouseholdInviteLink, revokeHouseholdInvite.
 * UI-only (bound to the browser sign-in, so no MCP tool may call them):
 *   previewHouseholdInvite, acceptHouseholdInvite.
 *
 * Every statement runs inside withActor, which assumes dollas_app for the
 * transaction. Creating, revoking, previewing, and accepting go through the
 * security-definer functions in 0022_household_invite_access, because that role
 * cannot write invite or membership rows and an invitee cannot see the
 * household until they join.
 */
export type InviteActor = {
  userId: string;
  householdId: string;
};

export type HouseholdPerson = {
  userId: string;
  name: string;
  email: string;
  role: HouseholdRole;
  you: boolean;
};

export type PendingInvite = {
  id: string;
  email: string;
  invitedBy: string;
  expiresAt: Date;
};

export type HouseholdPeople = {
  role: HouseholdRole;
  members: HouseholdPerson[];
  invites: PendingInvite[];
};

export type InviteMailOutcome = "sent" | "logged" | "not_sent";

export type CreatedInvite = PendingInvite & {
  link: string;
  mail: InviteMailOutcome;
};

export type InvitePreview = {
  householdId: string;
  householdName: string;
  invitedBy: string;
  /** Masked, for someone holding the link. */
  maskedEmail: string;
  state: InviteState;
  expiresAt: Date;
};

/**
 * neverthrow stays inside @dollas/domain. Services unwrap domain Results here
 * and hand back this plain shape, like the settings membership services.
 */
export type InviteResult<T> = { ok: true; value: T } | { ok: false; error: DomainError; memberMessage: string };

function ok<T>(value: T): InviteResult<T> {
  return { ok: true, value };
}

function err(error: DomainError, fallback = "Something went wrong with that invite."): InviteResult<never> {
  return { ok: false, error, memberMessage: inviteMessage(error, fallback) };
}

export type InviteDeps = {
  database?: AppDatabase;
  secret?: string;
  origin?: string;
  now?: () => Date;
  mailMode?: InviteMailMode;
  deliver?: typeof deliverHouseholdInviteEmail;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NOT_A_MEMBER = "You are not a member of this household.";

function textOf(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const cause = "cause" in error && error.cause instanceof Error ? error.cause.message : "";
  return `${error.message}\n${cause}`;
}

/** Known SQL messages become typed errors. Anything else is logged and hidden behind the fallback. */
function asDomainError(error: unknown, fallback: string): DomainError {
  if (error instanceof DomainError) return error;
  return inviteErrorFromText(textOf(error)) ?? new DomainError("invite_failed", fallback);
}

/** Text for a page action. Setup details and env names never reach a member. */
export function inviteMessage(error: unknown, fallback: string): string {
  if (hidesSetupDetail(error)) return fallback;
  return memberFacingMessage(error, fallback);
}

function roleOf(value: string): HouseholdRole {
  return value === "owner" ? "owner" : "member";
}

async function linkFor(inviteId: string, deps: InviteDeps): Promise<string> {
  const token = await deriveInviteToken(deps.secret ?? serverSecret(), inviteId);
  return `${deps.origin ?? siteOrigin()}${inviteLinkPath(token)}`;
}

async function loadPeople(actor: InviteActor, database: AppDatabase) {
  return withActor(
    actor.userId,
    async (tx) => {
      const members = await tx
        .select({ userId: householdMember.userId, role: householdMember.role, name: user.name, email: user.email })
        .from(householdMember)
        .innerJoin(user, eq(user.id, householdMember.userId))
        .where(eq(householdMember.householdId, actor.householdId));
      const invites = await tx
        .select({
          id: householdInvite.id,
          email: householdInvite.email,
          expiresAt: householdInvite.expiresAt,
          revokedAt: householdInvite.revokedAt,
          acceptedAt: householdInvite.acceptedAt,
          invitedBy: user.name,
        })
        .from(householdInvite)
        .innerJoin(user, eq(user.id, householdInvite.createdBy))
        .where(
          and(
            eq(householdInvite.householdId, actor.householdId),
            isNull(householdInvite.revokedAt),
            isNull(householdInvite.acceptedAt),
            sql`${householdInvite.expiresAt} > now()`,
          ),
        );
      return { members, invites };
    },
    database,
  );
}

/** Members with roles, and open invites. Any member can read this. MCP tools call this too. */
export async function listHouseholdPeople(
  actor: InviteActor,
  deps: InviteDeps = {},
): Promise<InviteResult<HouseholdPeople>> {
  if (!UUID.test(actor.householdId)) return err(new InviteError("not_found", NOT_A_MEMBER));
  try {
    const loaded = await loadPeople(actor, deps.database ?? getDb());
    const members = loaded.members
      .map((row) => ({
        userId: row.userId,
        name: row.name,
        email: row.email,
        role: roleOf(row.role),
        you: row.userId === actor.userId,
      }))
      .sort((a, b) => Number(b.role === "owner") - Number(a.role === "owner") || a.name.localeCompare(b.name));
    const me = members.find((member) => member.you);
    if (!me) return err(new InviteError("not_found", NOT_A_MEMBER));
    const invites = loaded.invites
      .map((row) => ({ id: row.id, email: row.email, invitedBy: row.invitedBy, expiresAt: row.expiresAt }))
      .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
    return ok({ role: me.role, members, invites });
  } catch (error) {
    logError(error, { action: "list-household-people", userId: actor.userId, householdId: actor.householdId });
    return err(asDomainError(error, "Could not load the household."));
  }
}

function mailOutcome(mode: InviteMailMode, sent: MailDeliveryResult): InviteMailOutcome {
  if (sent.isErr()) return "not_sent";
  return mode === "send" ? "sent" : "logged";
}

/**
 * Owner-only. Invites one email address for seven days and emails the link
 * through Resend when it is set up. The invite and its copyable link exist
 * even when mail is not set up or fails. MCP tools call this too.
 */
export async function createHouseholdInvite(
  actor: InviteActor,
  rawEmail: string,
  deps: InviteDeps = {},
): Promise<InviteResult<CreatedInvite>> {
  const database = deps.database ?? getDb();
  const now = deps.now?.() ?? new Date();
  const people = await listHouseholdPeople(actor, { ...deps, database });
  if (!people.ok) return people;
  const planned = planCreateInvite({
    actorUserId: actor.userId,
    seats: people.value.members,
    invites: people.value.invites.map((invite) => ({ ...invite, revokedAt: null, acceptedAt: null })),
    email: rawEmail,
    now,
  });
  if (planned.isErr()) {
    logInfo("household.invite.refused", { action: "create-invite", reason: planned.error.reason, userId: actor.userId });
    return err(planned.error);
  }

  const inviteId = crypto.randomUUID();
  let link: string;
  let expiresAt: Date;
  try {
    const token = await deriveInviteToken(deps.secret ?? serverSecret(), inviteId);
    link = `${deps.origin ?? siteOrigin()}${inviteLinkPath(token)}`;
    const tokenHash = await hashInviteToken(token);
    const rows = await withActor(
      actor.userId,
      (tx) =>
        tx.execute(
          sql`select create_household_invite(${actor.householdId}, ${inviteId}, ${planned.value.email}, ${tokenHash}) as expires_at`,
        ),
      database,
    );
    const raw = (rows as unknown as Array<{ expires_at?: unknown }>)[0]?.expires_at;
    expiresAt = raw instanceof Date ? raw : new Date(String(raw));
  } catch (error) {
    logError(error, { action: "create-invite", userId: actor.userId, householdId: actor.householdId });
    return err(asDomainError(error, "Could not create that invite."));
  }

  const me = people.value.members.find((member) => member.you);
  const [house] = await withActor(
    actor.userId,
    (tx) => tx.select({ name: household.name }).from(household).where(eq(household.id, actor.householdId)),
    database,
  ).catch(() => [] as Array<{ name: string }>);
  const mode = deps.mailMode ?? inviteMailMode();
  const sent = await (deps.deliver ?? deliverHouseholdInviteEmail)({
    email: planned.value.email,
    url: link,
    householdName: house?.name ?? "household",
    inviterName: me?.name ?? "Someone",
    expiresOn: expiresAt.toISOString().slice(0, 10),
  });
  const mail = mailOutcome(mode, sent);
  logInfo("household.invite.created", {
    action: "create-invite",
    userId: actor.userId,
    householdId: actor.householdId,
    inviteId,
    mail,
  });
  return ok({
    id: inviteId,
    email: planned.value.email,
    invitedBy: me?.name ?? "",
    expiresAt,
    link,
    mail,
  });
}

/** Owner-only. The same link the email carried, for an open invite. MCP tools call this too. */
export async function copyHouseholdInviteLink(
  actor: InviteActor,
  inviteId: string,
  deps: InviteDeps = {},
): Promise<InviteResult<{ link: string }>> {
  const people = await listHouseholdPeople(actor, deps);
  if (!people.ok) return people;
  if (people.value.role !== "owner") return err(inviteError("not_owner"));
  const invite = people.value.invites.find((item) => item.id === inviteId);
  if (!invite) return err(inviteError("not_pending"));
  try {
    return ok({ link: await linkFor(invite.id, deps) });
  } catch (error) {
    logError(error, { action: "copy-invite-link", userId: actor.userId, householdId: actor.householdId });
    return err(asDomainError(error, "Could not copy that link."));
  }
}

/** Owner-only. The link stops working right away. MCP tools call this too. */
export async function revokeHouseholdInvite(
  actor: InviteActor,
  inviteId: string,
  deps: InviteDeps = {},
): Promise<InviteResult<{ id: string }>> {
  const database = deps.database ?? getDb();
  const now = deps.now?.() ?? new Date();
  const people = await listHouseholdPeople(actor, { ...deps, database });
  if (!people.ok) return people;
  const invite = UUID.test(inviteId) ? people.value.invites.find((item) => item.id === inviteId) : undefined;
  const planned = planRevokeInvite({
    actorRole: people.value.role,
    invite: invite ? { expiresAt: invite.expiresAt, revokedAt: null, acceptedAt: null } : null,
    now,
  });
  if (planned.isErr()) {
    const error = planned.error.reason === "not_found" ? inviteError("not_pending") : planned.error;
    return err(error);
  }
  try {
    await withActor(
      actor.userId,
      (tx) => tx.execute(sql`select revoke_household_invite(${actor.householdId}, ${inviteId})`),
      database,
    );
  } catch (error) {
    logError(error, { action: "revoke-invite", userId: actor.userId, householdId: actor.householdId });
    return err(asDomainError(error, "Could not revoke that invite."));
  }
  logInfo("household.invite.revoked", { action: "revoke-invite", userId: actor.userId, householdId: actor.householdId, inviteId });
  return ok({ id: inviteId });
}

type PreviewRow = {
  household_id: string;
  household_name: string;
  invited_by: string;
  email: string;
  state: string;
  expires_at: Date | string;
};

async function readPreview(token: string, userId: string, database: AppDatabase): Promise<PreviewRow | null> {
  const tokenHash = await hashInviteToken(token);
  const rows = await withActor(
    userId,
    (tx) => tx.execute(sql`select * from household_invite_preview(${tokenHash})`),
    database,
  );
  return (rows as unknown as PreviewRow[])[0] ?? null;
}

function stateOf(value: string): InviteState {
  return value === "revoked" || value === "used" || value === "expired" ? value : "pending";
}

export type InviteVisit =
  | { kind: "invalid"; message: string }
  | { kind: "closed"; preview: InvitePreview; message: string }
  | { kind: "signed_out"; preview: InvitePreview }
  | { kind: "already_member"; preview: InvitePreview }
  | { kind: "blocked"; preview: InvitePreview; reason: InviteError["reason"]; message: string }
  | { kind: "ready"; preview: InvitePreview };

/**
 * UI-only. What the accept page shows for this link and this browser's login.
 * `viewer` is null when signed out.
 */
export async function previewHouseholdInvite(
  token: string,
  viewer: { userId: string; email: string; verified: boolean; memberOf: readonly string[] } | null,
  deps: InviteDeps = {},
): Promise<InviteVisit> {
  const invalid = { kind: "invalid" as const, message: inviteError("not_found").message };
  if (!isInviteToken(token)) return invalid;
  let row: PreviewRow | null;
  try {
    row = await readPreview(token, viewer?.userId ?? "", deps.database ?? getDb());
  } catch (error) {
    logError(error, { action: "preview-invite", userId: viewer?.userId ?? "" });
    return { kind: "invalid", message: "Could not open that invite. Try the link again." };
  }
  if (!row) return invalid;
  const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
  const preview: InvitePreview = {
    householdId: row.household_id,
    householdName: row.household_name,
    invitedBy: row.invited_by,
    maskedEmail: maskInviteEmail(row.email),
    state: stateOf(row.state),
    expiresAt,
  };
  if (viewer?.memberOf.includes(row.household_id)) return { kind: "already_member", preview };
  if (preview.state !== "pending") return { kind: "closed", preview, message: inviteError(preview.state).message };
  if (!viewer) return { kind: "signed_out", preview };
  const decided = decideInviteAcceptance({
    invite: {
      email: row.email,
      householdId: row.household_id,
      expiresAt,
      revokedAt: null,
      acceptedAt: null,
      acceptedBy: null,
    },
    user: { id: viewer.userId, email: viewer.email, verified: viewer.verified },
    memberOf: viewer.memberOf,
    now: deps.now?.() ?? new Date(),
  });
  if (decided.isErr()) {
    return { kind: "blocked", preview, reason: decided.error.reason, message: decided.error.message };
  }
  return { kind: "ready", preview };
}

/**
 * UI-only. Joins the signed-in, verified login to the invited household when
 * its email matches. The SQL function makes the invite single-use.
 */
export async function acceptHouseholdInvite(
  userId: string,
  token: string,
  deps: InviteDeps = {},
): Promise<InviteResult<{ householdId: string }>> {
  if (!isInviteToken(token)) return err(inviteError("not_found"));
  try {
    const tokenHash = await hashInviteToken(token);
    const rows = await withActor(
      userId,
      (tx) => tx.execute(sql`select accept_household_invite(${tokenHash}) as id`),
      deps.database ?? getDb(),
    );
    const id = (rows as unknown as Array<{ id?: unknown }>)[0]?.id;
    if (typeof id !== "string") return err(inviteError("not_found"));
    logInfo("household.invite.accepted", { action: "accept-invite", userId, householdId: id });
    return ok({ householdId: id });
  } catch (error) {
    const typed = asDomainError(error, "Could not join with that invite.");
    if (typed instanceof InviteError) {
      logInfo("household.invite.refused", { action: "accept-invite", userId, reason: typed.reason });
    } else {
      logError(error, { action: "accept-invite", userId });
    }
    return err(typed);
  }
}

export { INVITE_TTL_DAYS };
