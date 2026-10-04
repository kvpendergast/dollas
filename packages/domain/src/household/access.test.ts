import { describe, expect, it } from "vitest";
import { HouseholdAccessError, UnverifiedEmailError } from "../errors";
import { authorizeHouseholdAccess, emailCountsAsVerified } from "./access";

const householdId = "house_maple";

describe("household access", () => {
  it("lets a verified member read the household", () => {
    const result = authorizeHouseholdAccess(
      {
        userId: "user_ada",
        emailVerified: true,
        providers: ["credential"],
        memberships: [{ householdId, role: "owner" }],
      },
      householdId,
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().role).toBe("owner");
  });

  it("refuses someone who is not a member", () => {
    const result = authorizeHouseholdAccess(
      {
        userId: "user_outsider",
        emailVerified: true,
        providers: ["credential"],
        memberships: [{ householdId: "house_other", role: "owner" }],
      },
      householdId,
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(HouseholdAccessError);
  });

  it("keeps email and password members out until the email is verified", () => {
    const result = authorizeHouseholdAccess(
      {
        userId: "user_ada",
        emailVerified: false,
        providers: ["credential"],
        memberships: [{ householdId, role: "member" }],
      },
      householdId,
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(UnverifiedEmailError);
  });

  it("treats Google sign-in as a verified email", () => {
    expect(emailCountsAsVerified({ emailVerified: false, providers: ["google"] })).toBe(true);
    const result = authorizeHouseholdAccess(
      {
        userId: "user_google",
        emailVerified: false,
        providers: ["google"],
        memberships: [{ householdId, role: "member" }],
      },
      householdId,
    );
    expect(result.isOk()).toBe(true);
  });

  it("still refuses a Google account that is not in the household", () => {
    const result = authorizeHouseholdAccess(
      {
        userId: "user_google",
        emailVerified: true,
        providers: ["google"],
        memberships: [],
      },
      householdId,
    );
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(HouseholdAccessError);
  });
});
