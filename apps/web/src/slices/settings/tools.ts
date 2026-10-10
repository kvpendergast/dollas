import { z } from "zod";
import { confirmInput } from "@dollas/mcp";
import { answer, plural, tool, uuidInput } from "@/slices/agents/tool-kit";
import { deleteHousehold, describeMembership, leaveHousehold, transferOwnership, updateProfileName } from "./membership";

export const settingsTools = [
  tool({
    name: "get_my_profile",
    title: "Get my profile",
    description:
      "Your name, email, how you sign in, your role, whether you are the last owner, and the household's members. Changing email, password, or sign-in methods is only in the Dollas web app.",
    access: "read",
    input: {},
    async run(_args, { books }) {
      return answer(
        await describeMembership(books),
        (me) => `${me.name}, ${me.role} of ${me.householdName} with ${plural(me.members.length, "member")}.`,
      );
    },
  }),
  tool({
    name: "update_my_name",
    title: "Update my name",
    description: "Change the name other people in the household see for you.",
    access: "write",
    idempotent: true,
    input: { name: z.string().min(1).max(80).describe("Your name.") },
    async run(args, { books }) {
      return answer(await updateProfileName(books, args.name), (value) => `Your name is ${value.name} now.`);
    },
  }),
  tool({
    name: "transfer_ownership",
    title: "Hand off ownership",
    description: "Owner only. Make another member the owner. You become a member and lose owner-only actions such as invites and deleting the household.",
    access: "write",
    destructive: true,
    input: { member_user_id: uuidInput("The member's user"), confirm: confirmInput("hand off ownership and become a member") },
    async run(args, { books }) {
      return answer(await transferOwnership(books, args.member_user_id), () => "Ownership handed off. You are a member of this household now.");
    },
  }),
  tool({
    name: "leave_household",
    title: "Leave household",
    description:
      "Leave this household. You lose access to it, and this agent's connection ends with it. The last owner has to hand off ownership or delete the household instead.",
    access: "write",
    destructive: true,
    input: { confirm: confirmInput("leave this household and lose access to it") },
    async run(_args, { books }) {
      return answer(await leaveHousehold(books), () => "You left the household. This agent no longer has access.");
    },
  }),
  tool({
    name: "delete_household",
    title: "Delete household",
    description:
      "Owner only. Permanently delete the household and everything in it for every member. Needs confirm: true and household_name typed exactly as it is.",
    access: "write",
    destructive: true,
    input: {
      household_name: z.string().min(1).max(120).describe("The household's name, exactly, as the confirmation the web app asks for."),
      confirm: confirmInput("permanently delete the household and every member's access to it"),
    },
    async run(args, { books }) {
      return answer(await deleteHousehold(books, args.household_name), () => "The household is deleted.");
    },
  }),
];
