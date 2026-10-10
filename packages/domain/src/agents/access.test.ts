import { describe, expect, it } from "vitest";
import { AgentAccessError } from "../errors";
import {
  AGENT_READ_SCOPE,
  AGENT_REFRESH_SCOPE,
  AGENT_WRITE_SCOPE,
  agentChallengeScopes,
  decideAgentGrant,
  describeAgentAccess,
  grantedScopesFor,
  requestedAgentScopes,
  requireAgentAccess,
} from "./access";

const claims = {
  active: true,
  sub: "user-1",
  client_id: "client-1",
  household_id: "house-1",
  scope: `${AGENT_READ_SCOPE} ${AGENT_REFRESH_SCOPE}`,
};

describe("decideAgentGrant", () => {
  it("turns active claims into a read grant", () => {
    const grant = decideAgentGrant(claims)._unsafeUnwrap();
    expect(grant).toMatchObject({ userId: "user-1", householdId: "house-1", clientId: "client-1", access: "read" });
  });

  it("gives write only with the write scope", () => {
    const grant = decideAgentGrant({ ...claims, scope: `${AGENT_READ_SCOPE} ${AGENT_WRITE_SCOPE}` })._unsafeUnwrap();
    expect(grant.access).toBe("write");
  });

  it("rejects inactive, ownerless, and householdless tokens", () => {
    expect(decideAgentGrant({ ...claims, active: false })._unsafeUnwrapErr().reason).toBe("invalid_token");
    expect(decideAgentGrant({ active: false })._unsafeUnwrapErr().reason).toBe("invalid_token");
    expect(decideAgentGrant({ ...claims, sub: undefined })._unsafeUnwrapErr().reason).toBe("invalid_token");
    expect(decideAgentGrant({ ...claims, client_id: "" })._unsafeUnwrapErr().reason).toBe("invalid_token");
    expect(decideAgentGrant({ ...claims, household_id: undefined })._unsafeUnwrapErr().reason).toBe("no_household");
  });

  it("rejects a token with no Dollas scope", () => {
    const error = decideAgentGrant({ ...claims, scope: "openid email" })._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(AgentAccessError);
    expect(error.reason).toBe("insufficient_scope");
  });
});

describe("requireAgentAccess", () => {
  it("lets a read grant read but not write", () => {
    const grant = decideAgentGrant(claims)._unsafeUnwrap();
    expect(requireAgentAccess(grant, "read").isOk()).toBe(true);
    const denied = requireAgentAccess(grant, "write")._unsafeUnwrapErr();
    expect(denied.reason).toBe("insufficient_scope");
    expect(denied.message).toMatch(/read and write/);
  });

  it("lets a write grant write", () => {
    const grant = decideAgentGrant({ ...claims, scope: `${AGENT_READ_SCOPE} ${AGENT_WRITE_SCOPE}` })._unsafeUnwrap();
    expect(requireAgentAccess(grant, "write").isOk()).toBe(true);
  });
});

describe("grantedScopesFor", () => {
  const all = [AGENT_READ_SCOPE, AGENT_WRITE_SCOPE, AGENT_REFRESH_SCOPE];

  it("narrows to read when the member picks read", () => {
    expect(grantedScopesFor(all, "read")._unsafeUnwrap()).toEqual([AGENT_READ_SCOPE, AGENT_REFRESH_SCOPE]);
  });

  it("grants write only when the member picks it and the client asked", () => {
    expect(grantedScopesFor(all, "read_write")._unsafeUnwrap()).toEqual(all);
    expect(grantedScopesFor([AGENT_READ_SCOPE], "read_write").isErr()).toBe(true);
  });

  it("rejects unknown choices and requests without read", () => {
    expect(grantedScopesFor(all, "admin").isErr()).toBe(true);
    expect(grantedScopesFor([AGENT_WRITE_SCOPE], "read").isErr()).toBe(true);
  });
});

describe("requestedAgentScopes", () => {
  it("keeps known scopes and defaults to read", () => {
    expect(requestedAgentScopes(`${AGENT_WRITE_SCOPE} profile ${AGENT_READ_SCOPE}`)).toEqual([
      AGENT_WRITE_SCOPE,
      AGENT_READ_SCOPE,
    ]);
    expect(requestedAgentScopes(undefined)).toEqual([AGENT_READ_SCOPE]);
  });
});

describe("labels", () => {
  it("names challenge scopes and access", () => {
    expect(agentChallengeScopes()).toEqual([AGENT_READ_SCOPE, AGENT_WRITE_SCOPE, AGENT_REFRESH_SCOPE]);
    expect(describeAgentAccess([AGENT_READ_SCOPE])).toBe("Read only");
    expect(describeAgentAccess([AGENT_READ_SCOPE, AGENT_WRITE_SCOPE])).toBe("Read and write");
  });
});
