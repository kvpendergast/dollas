import { describe, expect, it } from "vitest";
import { LastOwnerError, MembershipError } from "../errors";
import { memberFacingMessage } from "../setup/config";
import {
  DELETE_CONFIRMATION_MESSAGE,
  LAST_OWNER_MESSAGE,
  householdRowsInScope,
  planDeleteHousehold,
  planLeaveHousehold,
  planProfileName,
  planTransferOwnership,
  signInMethod,
  type HouseholdSeat,
} from "./membership";

const house = "house-a";
const other = "house-b";

const owner: HouseholdSeat = { userId: "ada", role: "owner" };
const member: HouseholdSeat = { userId: "bea", role: "member" };
const secondOwner: HouseholdSeat = { userId: "cam", role: "owner" };

describe("profile name", () => {
  it("keeps a home name and collapses extra space", () => {
    const result = planProfileName("  Ada   Maple  ");
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe("Ada Maple");
  });

  it("rejects a blank or huge name", () => {
    expect(planProfileName(" ")._unsafeUnwrapErr()).toBeInstanceOf(MembershipError);
    expect(planProfileName("A")._unsafeUnwrapErr().message).toBe("Enter the name you use at home.");
    expect(planProfileName("A".repeat(81))._unsafeUnwrapErr().message).toBe("That name is too long.");
    expect(planProfileName("Ada\nMaple").isErr()).toBe(true);
  });
});

describe("leave household", () => {
  it("blocks the last owner", () => {
    const result = planLeaveHousehold({ actorUserId: "ada", seats: [owner, member] });
    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(LastOwnerError);
    expect(memberFacingMessage(error)).toBe(LAST_OWNER_MESSAGE);
    expect(memberFacingMessage(error)).not.toMatch(/DATABASE_|RESEND_|GOOGLE_|PLAID_/);
  });

  it("lets a member leave, and lets an owner leave when another owner remains", () => {
    expect(planLeaveHousehold({ actorUserId: "bea", seats: [owner, member] }).isOk()).toBe(true);
    expect(planLeaveHousehold({ actorUserId: "ada", seats: [owner, secondOwner] })._unsafeUnwrap().userId).toBe("ada");
  });

  it("refuses someone who is not in the household", () => {
    const result = planLeaveHousehold({ actorUserId: "nope", seats: [owner] });
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(MembershipError);
  });
});

describe("ownership transfer", () => {
  it("hands the caller's ownership to another member", () => {
    const result = planTransferOwnership({
      actorUserId: "ada",
      targetUserId: "bea",
      seats: [owner, member],
    });
    expect(result._unsafeUnwrap()).toEqual({ fromUserId: "ada", toUserId: "bea" });
  });

  it("refuses a member, a missing person, and someone who is already an owner", () => {
    expect(
      planTransferOwnership({ actorUserId: "bea", targetUserId: "ada", seats: [owner, member] }).isErr(),
    ).toBe(true);
    expect(
      planTransferOwnership({ actorUserId: "ada", targetUserId: "missing", seats: [owner, member] }).isErr(),
    ).toBe(true);
    expect(
      planTransferOwnership({ actorUserId: "ada", targetUserId: "cam", seats: [owner, secondOwner] })._unsafeUnwrapErr()
        .message,
    ).toBe("That person is already an owner.");
    expect(
      planTransferOwnership({ actorUserId: "ada", targetUserId: "ada", seats: [owner, member] })._unsafeUnwrapErr()
        .message,
    ).toBe("Choose another member.");
  });
});

describe("delete household scope", () => {
  const rows = [
    { id: "tx-a", householdId: house },
    { id: "member-a", householdId: house },
    { id: "tx-b", householdId: other },
    { id: "member-b", householdId: other },
  ];

  it("removes only the named household after the owner types its name", () => {
    const result = planDeleteHousehold({
      actorUserId: "ada",
      householdId: house,
      householdName: "Maple House",
      confirmation: "  Maple House  ",
      seats: [owner, member],
      rows,
    });
    expect(result._unsafeUnwrap()).toEqual({
      householdId: house,
      removedIds: ["tx-a", "member-a"],
    });
    expect(householdRowsInScope(rows, house).map((row) => row.id)).toEqual(["tx-a", "member-a"]);
    expect(householdRowsInScope(rows, house).some((row) => row.householdId === other)).toBe(false);
  });

  it("refuses a wrong name, a member, and someone outside the household", () => {
    const wrong = planDeleteHousehold({
      actorUserId: "ada",
      householdId: house,
      householdName: "Maple House",
      confirmation: "maple house",
      seats: [owner],
      rows,
    });
    expect(wrong._unsafeUnwrapErr().message).toBe(DELETE_CONFIRMATION_MESSAGE);
    expect(wrong.isOk() ? [] : householdRowsInScope(rows, other)).toHaveLength(2);

    expect(
      planDeleteHousehold({
        actorUserId: "bea",
        householdId: house,
        householdName: "Maple House",
        confirmation: "Maple House",
        seats: [owner, member],
        rows,
      })._unsafeUnwrapErr().message,
    ).toBe("Only an owner can delete the household.");

    expect(
      planDeleteHousehold({
        actorUserId: "outsider",
        householdId: house,
        householdName: "Maple House",
        confirmation: "Maple House",
        seats: [owner],
        rows,
      }).isErr(),
    ).toBe(true);
  });
});

describe("sign-in method", () => {
  it("treats Google without a credential login as Google-only", () => {
    expect(signInMethod(["google"])).toBe("google");
    expect(signInMethod(["credential"])).toBe("password");
    expect(signInMethod(["credential", "google"])).toBe("both");
    expect(signInMethod([])).toBe("none");
  });
});
