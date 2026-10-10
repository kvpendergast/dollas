import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import {
  INVITE_MESSAGES,
  MailDeliveryError,
  acceptedMailDelivery,
  hashInviteToken,
  rejectedMailDelivery,
} from "@dollas/domain";
import { withActor } from "../../db/actor";
import { assertAppRoleSubjectToRls, migrateWithUrl } from "../../db/apply-migrations";
import { openAppDatabase } from "../../db/client";
import { category, household, householdInvite, ledgerAccount, transaction } from "../../db/schema";
import { initTelemetry } from "../../lib/telemetry";
import {
  acceptHouseholdInvite,
  copyHouseholdInviteLink,
  createHouseholdInvite,
  listHouseholdPeople,
  previewHouseholdInvite,
  revokeHouseholdInvite,
  type InviteDeps,
} from "./invites";

const OWNER_URL = "postgresql://dollas:dollas@127.0.0.1:5432/dollas";
const APP_URL = "postgresql://dollas_app:dollas@127.0.0.1:5432/dollas";
const ORIGIN = "http://invite.test";
const SECRET = "invite-test-secret-that-is-long-enough";

/** Drizzle wraps the Postgres error; the RAISE text is on the cause. */
async function rejectsWith(fn: () => Promise<unknown>, pattern: RegExp) {
  await assert.rejects(fn, (error: unknown) => {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
    const text = `${error instanceof Error ? error.message : ""}\n${cause}`;
    assert.match(text, pattern);
    return true;
  });
}

function tokenOf(link: string): string {
  const match = /\/invite\/([A-Za-z0-9_-]{43})$/.exec(link);
  assert.ok(match, `link has a token: ${link}`);
  return match[1];
}

describe("household invites", () => {
  it("invites by email, binds to that email, works once, revokes, and keeps the household hidden until accepted", async (t) => {
    initTelemetry();
    const host = new URL(OWNER_URL).hostname;
    assert.ok(host === "127.0.0.1" || host === "localhost");
    const owner = postgres(OWNER_URL, { max: 1, prepare: false, connect_timeout: 5, onnotice() {} });
    try {
      await owner`select 1`;
    } catch (error) {
      await owner.end({ timeout: 1 }).catch(() => undefined);
      if (process.env.CI) throw error;
      t.skip("Postgres is not running on 127.0.0.1:5432");
      return;
    }

    const ada = crypto.randomUUID(); // owner of Maple
    const eve = crypto.randomUUID(); // member of Maple
    const bea = crypto.randomUUID(); // invited, no household yet
    const cam = crypto.randomUUID(); // owner of Other House
    const dee = crypto.randomUUID(); // unverified, invited
    const fay = crypto.randomUUID(); // invited, then revoked
    const gus = crypto.randomUUID(); // invited, then expired
    const users = [ada, eve, bea, cam, dee, fay, gus];
    const emailOf = (id: string) => `${id}@example.test`;
    let houseA = "";
    let houseB = "";
    let closeApp: (() => Promise<void>) | undefined;
    let failure: unknown;

    try {
      const appRole = await owner<{ n: string }[]>`
        select count(*)::text as n from pg_roles where rolname = 'dollas_app'
      `;
      if (appRole[0]?.n === "0") {
        await owner.unsafe("CREATE ROLE dollas_app LOGIN PASSWORD 'dollas' NOSUPERUSER NOBYPASSRLS");
      }
      await migrateWithUrl(OWNER_URL, { env: { DATABASE_URL: APP_URL } });
      await assertAppRoleSubjectToRls(OWNER_URL);
      const app = openAppDatabase(OWNER_URL, 1);
      closeApp = () => app.close();

      const mails: Array<{ email: string; url: string; householdName: string; inviterName: string }> = [];
      let mailFails = false;
      const deps: InviteDeps = {
        database: app.db,
        secret: SECRET,
        origin: ORIGIN,
        mailMode: "send",
        deliver: async (input) => {
          mails.push(input);
          return mailFails ? rejectedMailDelivery(new MailDeliveryError("Resend could not send")) : acceptedMailDelivery();
        },
      };

      await owner`
        insert into "user" (id, name, email, email_verified)
        values
          (${ada}, 'Ada', ${emailOf(ada)}, true),
          (${eve}, 'Eve', ${emailOf(eve)}, true),
          (${bea}, 'Bea', ${emailOf(bea)}, true),
          (${cam}, 'Cam', ${emailOf(cam)}, true),
          (${dee}, 'Dee', ${emailOf(dee)}, false),
          (${fay}, 'Fay', ${emailOf(fay)}, true),
          (${gus}, 'Gus', ${emailOf(gus)}, true)
      `;
      const houses = await owner<{ id: string; name: string }[]>`
        insert into household (name, created_by)
        values ('Maple House', ${ada}), ('Other House', ${cam})
        returning id, name
      `;
      houseA = houses.find((row) => row.name === "Maple House")?.id ?? "";
      houseB = houses.find((row) => row.name === "Other House")?.id ?? "";
      assert.ok(houseA && houseB);
      await owner`
        insert into household_member (household_id, user_id, role)
        values (${houseA}, ${ada}, 'owner'), (${houseA}, ${eve}, 'member'), (${houseB}, ${cam}, 'owner')
      `;
      const [checking] = await owner<{ id: string }[]>`
        insert into ledger_account (household_id, name, type) values (${houseA}, 'Checking', 'checking') returning id
      `;
      const [rent] = await owner<{ id: string }[]>`
        insert into category (household_id, name, kind) values (${houseA}, 'Rent', 'expense') returning id
      `;
      const [txA] = await owner.begin(async (tx) => {
        const [row] = await tx<{ id: string }[]>`
          insert into transaction (household_id, account_id, occurred_on, payee, amount_cents)
          values (${houseA}, ${checking.id}, '2026-10-01', 'Landlord', -150000)
          returning id
        `;
        await tx`
          insert into transaction_split (transaction_id, household_id, category_id, amount_cents)
          values (${row.id}, ${houseA}, ${rent.id}, -150000)
        `;
        return [row];
      });

      const maple = { userId: ada, householdId: houseA };

      // Before any invite: Bea sees nothing of Maple, including its invites.
      const beaSees = async () =>
        withActor(
          bea,
          async (tx) => ({
            houses: await tx.select({ id: household.id }).from(household).where(eq(household.id, houseA)),
            accounts: await tx.select({ id: ledgerAccount.id }).from(ledgerAccount).where(eq(ledgerAccount.householdId, houseA)),
            categories: await tx.select({ id: category.id }).from(category).where(eq(category.householdId, houseA)),
            transactions: await tx.select({ id: transaction.id }).from(transaction).where(eq(transaction.householdId, houseA)),
            invites: await tx.select({ id: householdInvite.id }).from(householdInvite),
          }),
          app.db,
        );
      const before = await beaSees();
      assert.deepEqual(
        [before.houses.length, before.accounts.length, before.categories.length, before.transactions.length],
        [0, 0, 0, 0],
      );

      // Owner-only create. A member and an outsider are refused, in the service and in SQL.
      const byMember = await createHouseholdInvite({ userId: eve, householdId: houseA }, emailOf(bea), deps);
      assert.equal(byMember.ok, false);
      if (!byMember.ok) assert.equal(byMember.memberMessage, INVITE_MESSAGES.not_owner);
      const byOutsider = await createHouseholdInvite({ userId: cam, householdId: houseA }, emailOf(bea), deps);
      assert.equal(byOutsider.ok, false);
      await rejectsWith(async () => {
        const inviteId = crypto.randomUUID();
        await withActor(
          eve,
          (tx) => tx.execute(sql`select create_household_invite(${houseA}, ${inviteId}, 'zed@example.test', ${"a".repeat(64)})`),
          app.db,
        );
      }, /Only an owner can invite or revoke/);
      // dollas_app cannot write invite rows directly.
      await assert.rejects(() =>
        withActor(
          ada,
          (tx) =>
            tx.insert(householdInvite).values({
              householdId: houseA,
              email: "zed@example.test",
              tokenHash: "b".repeat(64),
              createdBy: ada,
              expiresAt: new Date(Date.now() + 1000),
            }),
          app.db,
        ),
      );

      // Owner invites Bea. Mixed case is normalized. Only the hash is stored.
      const created = await createHouseholdInvite(maple, `  ${emailOf(bea).toUpperCase()} `, deps);
      assert.equal(created.ok, true, created.ok ? "" : created.memberMessage);
      if (!created.ok) return;
      assert.equal(created.value.email, emailOf(bea));
      assert.equal(created.value.mail, "sent");
      assert.ok(created.value.link.startsWith(`${ORIGIN}/invite/`));
      const token = tokenOf(created.value.link);
      const [stored] = await owner<{ token_hash: string; email: string; expires_at: Date }[]>`
        select token_hash, email, expires_at from household_invite where id = ${created.value.id}
      `;
      assert.equal(stored.token_hash, await hashInviteToken(token));
      assert.notEqual(stored.token_hash, token);
      const rowText = JSON.stringify(await owner`select * from household_invite where id = ${created.value.id}`);
      assert.equal(rowText.includes(token), false);
      const days = (stored.expires_at.getTime() - Date.now()) / 86_400_000;
      assert.ok(days > 6.9 && days <= 7.01, `expires in seven days, got ${days}`);
      assert.equal(mails.length, 1);
      assert.equal(mails[0].email, emailOf(bea));
      assert.equal(mails[0].url, created.value.link);
      assert.equal(mails[0].householdName, "Maple House");
      assert.equal(mails[0].inviterName, "Ada");

      // Copy link returns the same link, owner-only.
      const copied = await copyHouseholdInviteLink(maple, created.value.id, deps);
      assert.equal(copied.ok && copied.value.link, created.value.link);
      const memberCopy = await copyHouseholdInviteLink({ userId: eve, householdId: houseA }, created.value.id, deps);
      assert.equal(memberCopy.ok, false);

      // A second open invite to the same address, or an invite to a member, is refused.
      const again = await createHouseholdInvite(maple, emailOf(bea), deps);
      assert.equal(!again.ok && again.memberMessage, INVITE_MESSAGES.already_invited);
      const toMember = await createHouseholdInvite(maple, emailOf(eve), deps);
      assert.equal(!toMember.ok && toMember.memberMessage, INVITE_MESSAGES.already_member);

      // The list shows members with roles and the open invite to every member.
      const listed = await listHouseholdPeople({ userId: eve, householdId: houseA }, deps);
      assert.equal(listed.ok, true);
      if (listed.ok) {
        assert.equal(listed.value.role, "member");
        assert.deepEqual(
          listed.value.members.map((m) => [m.name, m.role]),
          [
            ["Ada", "owner"],
            ["Eve", "member"],
          ],
        );
        assert.deepEqual(listed.value.invites.map((i) => i.email), [emailOf(bea)]);
      }
      const outsiderList = await listHouseholdPeople({ userId: cam, householdId: houseA }, deps);
      assert.equal(outsiderList.ok, false);

      // Still hidden from Bea while the invite is open.
      const stillHidden = await beaSees();
      assert.equal(stillHidden.houses.length + stillHidden.transactions.length + stillHidden.invites.length, 0);

      // Preview: signed out, wrong email, ready.
      const signedOut = await previewHouseholdInvite(token, null, deps);
      assert.equal(signedOut.kind, "signed_out");
      if (signedOut.kind === "signed_out") {
        assert.equal(signedOut.preview.householdName, "Maple House");
        assert.equal(signedOut.preview.invitedBy, "Ada");
        assert.equal(signedOut.preview.maskedEmail.includes(bea), false);
      }
      const camView = await previewHouseholdInvite(token, { userId: cam, email: emailOf(cam), verified: true, memberOf: [houseB] }, deps);
      assert.equal(camView.kind === "blocked" && camView.reason, "wrong_email");
      const beaView = await previewHouseholdInvite(token, { userId: bea, email: emailOf(bea), verified: true, memberOf: [] }, deps);
      assert.equal(beaView.kind, "ready");
      const bogus = await previewHouseholdInvite("x".repeat(43), null, deps);
      assert.equal(bogus.kind, "invalid");

      // Wrong email and a malformed token are refused by the SQL path too.
      const camAccept = await acceptHouseholdInvite(cam, token, deps);
      assert.equal(!camAccept.ok && camAccept.memberMessage, INVITE_MESSAGES.wrong_email);
      const junk = await acceptHouseholdInvite(bea, "not-a-token", deps);
      assert.equal(!junk.ok && junk.memberMessage, INVITE_MESSAGES.not_found);

      // Bea accepts and now sees and edits everything in Maple.
      const accepted = await acceptHouseholdInvite(bea, token, deps);
      assert.equal(accepted.ok && accepted.value.householdId, houseA);
      const [membership] = await owner<{ role: string }[]>`
        select role from household_member where household_id = ${houseA} and user_id = ${bea}
      `;
      assert.equal(membership?.role, "member");
      const after = await beaSees();
      assert.equal(after.houses.length, 1);
      assert.equal(after.accounts.length, 1);
      assert.equal(after.categories.length, 1);
      assert.deepEqual(
        after.transactions.map((row) => row.id),
        [txA.id],
      );
      const renamed = await withActor(
        bea,
        (tx) => tx.update(category).set({ name: "Rent and fees" }).where(eq(category.id, rent.id)).returning({ id: category.id }),
        app.db,
      );
      assert.equal(renamed.length, 1);
      const beaOther = await withActor(bea, (tx) => tx.select({ id: household.id }).from(household).where(eq(household.id, houseB)), app.db);
      assert.equal(beaOther.length, 0);

      // Single use: a second click by Bea is a no-op; nobody else can use it.
      const twice = await acceptHouseholdInvite(bea, token, deps);
      assert.equal(twice.ok, true);
      const reuse = await acceptHouseholdInvite(cam, token, deps);
      assert.equal(!reuse.ok && reuse.memberMessage, INVITE_MESSAGES.used);
      const beaPreviewAfter = await previewHouseholdInvite(token, { userId: bea, email: emailOf(bea), verified: true, memberOf: [houseA] }, deps);
      assert.equal(beaPreviewAfter.kind, "already_member");
      const closedPreview = await previewHouseholdInvite(token, null, deps);
      assert.equal(closedPreview.kind === "closed" && closedPreview.message, INVITE_MESSAGES.used);
      const [acceptedRow] = await owner<{ accepted_by: string | null }[]>`
        select accepted_by from household_invite where id = ${created.value.id}
      `;
      assert.equal(acceptedRow?.accepted_by, bea);

      // Unverified email cannot accept even with the right address.
      const deeInvite = await createHouseholdInvite(maple, emailOf(dee), deps);
      assert.equal(deeInvite.ok, true);
      if (deeInvite.ok) {
        const deeAccept = await acceptHouseholdInvite(dee, tokenOf(deeInvite.value.link), deps);
        assert.equal(!deeAccept.ok && deeAccept.memberMessage, INVITE_MESSAGES.unverified);
      }

      // Revoke: owner-only, then the link stops working. Mail failure still leaves a copyable invite.
      mailFails = true;
      const fayInvite = await createHouseholdInvite(maple, emailOf(fay), deps);
      mailFails = false;
      assert.equal(fayInvite.ok && fayInvite.value.mail, "not_sent");
      if (fayInvite.ok) {
        const memberRevoke = await revokeHouseholdInvite({ userId: eve, householdId: houseA }, fayInvite.value.id, deps);
        assert.equal(!memberRevoke.ok && memberRevoke.memberMessage, INVITE_MESSAGES.not_owner);
        const outsiderRevoke = await revokeHouseholdInvite({ userId: cam, householdId: houseB }, fayInvite.value.id, deps);
        assert.equal(outsiderRevoke.ok, false);
        await rejectsWith(async () => {
          const inviteId = fayInvite.value.id;
          await withActor(cam, (tx) => tx.execute(sql`select revoke_household_invite(${houseB}, ${inviteId})`), app.db);
        }, /no longer open/);
        const revoked = await revokeHouseholdInvite(maple, fayInvite.value.id, deps);
        assert.equal(revoked.ok, true);
        const revokedTwice = await revokeHouseholdInvite(maple, fayInvite.value.id, deps);
        assert.equal(!revokedTwice.ok && revokedTwice.memberMessage, INVITE_MESSAGES.not_pending);
        const fayAccept = await acceptHouseholdInvite(fay, tokenOf(fayInvite.value.link), deps);
        assert.equal(!fayAccept.ok && fayAccept.memberMessage, INVITE_MESSAGES.revoked);
        const relisted = await listHouseholdPeople(maple, deps);
        assert.equal(relisted.ok && relisted.value.invites.some((i) => i.id === fayInvite.value.id), false);
        // After a revoke the owner can invite the same address again.
        const fresh = await createHouseholdInvite(maple, emailOf(fay), deps);
        assert.equal(fresh.ok, true);
      }

      // Expiry.
      const gusInvite = await createHouseholdInvite(maple, emailOf(gus), deps);
      assert.equal(gusInvite.ok, true);
      if (gusInvite.ok) {
        await owner`update household_invite set expires_at = now() - interval '1 minute' where id = ${gusInvite.value.id}`;
        const gusAccept = await acceptHouseholdInvite(gus, tokenOf(gusInvite.value.link), deps);
        assert.equal(!gusAccept.ok && gusAccept.memberMessage, INVITE_MESSAGES.expired);
        const gusPreview = await previewHouseholdInvite(tokenOf(gusInvite.value.link), null, deps);
        assert.equal(gusPreview.kind === "closed" && gusPreview.message, INVITE_MESSAGES.expired);
      }

      // Someone who already keeps other books is refused instead of getting two households.
      const camInvite = await createHouseholdInvite(maple, emailOf(cam), deps);
      assert.equal(camInvite.ok, true);
      if (camInvite.ok) {
        const camJoin = await acceptHouseholdInvite(cam, tokenOf(camInvite.value.link), deps);
        assert.equal(!camJoin.ok && camJoin.memberMessage, INVITE_MESSAGES.other_household);
      }

      // The invitee cannot call create or revoke on a household they do not own.
      const beaCreate = await createHouseholdInvite({ userId: bea, householdId: houseA }, "zed@example.test", deps);
      assert.equal(!beaCreate.ok && beaCreate.memberMessage, INVITE_MESSAGES.not_owner);
    } catch (error) {
      failure = error;
    } finally {
      try {
        if (houseA) await owner`delete from household where id = ${houseA}`;
        if (houseB) await owner`delete from household where id = ${houseB}`;
        await owner`delete from "user" where id in ${owner(users)}`;
      } catch (cleanupError) {
        console.error(cleanupError);
      }
      if (closeApp) await closeApp().catch(() => undefined);
      await owner.end({ timeout: 5 }).catch(() => undefined);
    }
    if (failure) throw failure;
  });
});
