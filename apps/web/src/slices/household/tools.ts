import { z } from "zod";
import { answer, plural, tool, uuidInput } from "@/slices/agents/tool-kit";
import { copyHouseholdInviteLink, createHouseholdInvite, listHouseholdPeople, revokeHouseholdInvite } from "./invites";

export const householdTools = [
  tool({
    name: "list_household",
    title: "List household members and invites",
    description: "Members of the household (name, email, owner or member, which one is you) and open invites with their expiry. The whole list in one response.",
    access: "read",
    input: {},
    async run(_args, { books }) {
      return answer(
        await listHouseholdPeople(books),
        (people) => `${plural(people.members.length, "member")}, ${plural(people.invites.length, "open invite")}.`,
      );
    },
  }),
  tool({
    name: "create_invite",
    title: "Invite someone",
    description:
      "Owner only. Invite an email address to join the household for seven days. Dollas emails the link when email is set up; the link is returned either way so the member can send it.",
    access: "write",
    input: { email: z.string().email().max(254).describe("The address the person will sign in with.") },
    async run(args, { books }) {
      return answer(
        await createHouseholdInvite(books, args.email),
        (invite) => (invite.mail === "sent" ? `Invite emailed to ${invite.email}.` : `Invite ready for ${invite.email}. Email did not go out; share the link.`),
      );
    },
  }),
  tool({
    name: "copy_invite_link",
    title: "Copy invite link",
    description:
      "Owner only. The link for an open invite, the same one the email carried, to send yourself. Needs write access because the link lets someone join.",
    access: "write",
    input: { invite_id: uuidInput("Invite") },
    async run(args, { books }) {
      return answer(await copyHouseholdInviteLink(books, args.invite_id), () => "Here is the invite link.");
    },
  }),
  tool({
    name: "revoke_invite",
    title: "Revoke invite",
    description: "Owner only. Cancel an open invite so its link no longer works.",
    access: "write",
    idempotent: true,
    input: { invite_id: uuidInput("Invite") },
    async run(args, { books }) {
      return answer(await revokeHouseholdInvite(books, args.invite_id), () => "Revoked that invite.");
    },
  }),
];
