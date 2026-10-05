import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APP_ROLE, ASSUME_APP_ROLE_SQL, isSubjectToRowLevelSecurity, type RoleSecurityFacts } from "./app-role";

const appRole: RoleSecurityFacts = {
  currentUser: APP_ROLE,
  superuser: false,
  bypassrls: false,
  ownsHousehold: false,
  forceRls: false,
  rlsEnabled: true,
};

describe("isSubjectToRowLevelSecurity", () => {
  it("accepts the non-owner app role", () => {
    assert.equal(isSubjectToRowLevelSecurity(appRole), true);
  });

  it("rejects the table owner, superuser, and BYPASSRLS", () => {
    assert.equal(isSubjectToRowLevelSecurity({ ...appRole, currentUser: "neondb_owner", ownsHousehold: true }), false);
    assert.equal(isSubjectToRowLevelSecurity({ ...appRole, superuser: true }), false);
    assert.equal(isSubjectToRowLevelSecurity({ ...appRole, bypassrls: true }), false);
    assert.equal(isSubjectToRowLevelSecurity({ ...appRole, ownsHousehold: true }), false);
    assert.equal(isSubjectToRowLevelSecurity({ ...appRole, rlsEnabled: false }), false);
  });

  it("accepts an owner only when row security is forced and the user is dollas_app", () => {
    assert.equal(isSubjectToRowLevelSecurity({ ...appRole, ownsHousehold: true, forceRls: true }), true);
  });

  it("assumes dollas_app inside the transaction and does not embed a password", () => {
    assert.equal(ASSUME_APP_ROLE_SQL, "SET LOCAL ROLE dollas_app");
    assert.equal(/password/i.test(ASSUME_APP_ROLE_SQL), false);
  });
});
