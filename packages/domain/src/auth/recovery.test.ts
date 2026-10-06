import { describe, expect, it } from "vitest";
import { InvalidAuthEmailError, RateLimitedError } from "../errors";
import {
  FORGOT_PASSWORD_MESSAGE,
  GENERIC_SIGN_IN_MESSAGE,
  RESEND_VERIFICATION_MESSAGE,
  UNVERIFIED_SIGN_IN_MESSAGE,
  requestPasswordResetNotice,
  resendVerificationNotice,
  resetPasswordFailure,
  signInFailureFromCode,
  type RateLimitStore,
} from "./recovery";

const floorMs = 50;

function clockHarness() {
  let now = 1_000;
  return {
    clock: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    elapsed: () => now - 1_000,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function forgotten(input: {
  email?: string;
  ip?: string;
  store?: RateLimitStore;
  nowMs?: number;
  workMs?: number;
  fail?: unknown;
  calls?: string[];
}) {
  const time = clockHarness();
  const calls = input.calls ?? [];
  const run = requestPasswordResetNotice({
    email: input.email ?? "Ada@Maple.local",
    ip: input.ip ?? "203.0.113.10",
    store: input.store ?? new Map(),
    nowMs: input.nowMs ?? 0,
    floorMs,
    clock: time.clock,
    sleep: time.sleep,
    requestReset: async (email) => {
      calls.push(email);
      time.advance(input.workMs ?? 0);
      if (input.fail) throw input.fail;
    },
  });
  return { run, time, calls };
}

describe("forgot password", () => {
  it("returns the same message and similar timing whether the reset runs, fails, or takes longer", async () => {
    const quiet = forgotten({ workMs: 0 });
    const slow = forgotten({ workMs: 20 });
    const missing = forgotten({ fail: new Error("User not found") });
    const outage = forgotten({ fail: new Error("database exploded") });

    const results = await Promise.all([quiet.run, slow.run, missing.run, outage.run]);
    for (const result of results) {
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual({ message: FORGOT_PASSWORD_MESSAGE });
      const published = JSON.stringify(result._unsafeUnwrap());
      expect(published.includes("not found")).toBe(false);
      expect(published.includes("no account")).toBe(false);
      expect(published.includes("does not exist")).toBe(false);
      expect(published.includes("unknown")).toBe(false);
      expect(published.includes("database")).toBe(false);
    }
    const elapsed = [quiet.time.elapsed(), slow.time.elapsed(), missing.time.elapsed(), outage.time.elapsed()];
    expect(new Set(elapsed)).toEqual(new Set([floorMs]));
  });

  it("does not send again once the email is over the limit, and still says the same thing", async () => {
    const store: RateLimitStore = new Map();
    const calls: string[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const { run } = forgotten({
        email: attempt % 2 === 0 ? "ada@maple.local" : "Ada@Maple.local",
        store,
        calls,
        nowMs: 5_000,
      });
      const result = await run;
      expect(result._unsafeUnwrap().message).toBe(FORGOT_PASSWORD_MESSAGE);
    }
    expect(calls).toEqual(["ada@maple.local", "ada@maple.local", "ada@maple.local"]);
  });

  it("rejects a blank address before asking for a reset", async () => {
    const calls: string[] = [];
    const { run } = forgotten({ email: "not-an-email", calls });
    const result = await run;
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(InvalidAuthEmailError);
    expect(calls).toEqual([]);
  });
});

describe("resend verification", () => {
  it("rate limits a second send for the same email and tells them to wait", async () => {
    const store: RateLimitStore = new Map();
    const calls: string[] = [];
    const send = async (email: string) => {
      calls.push(email);
    };
    const first = await resendVerificationNotice({
      email: "Ada@Maple.local",
      ip: "203.0.113.10",
      store,
      nowMs: 10_000,
      send,
    });
    const second = await resendVerificationNotice({
      email: "ada@maple.local",
      ip: "198.51.100.4",
      store,
      nowMs: 20_000,
      send,
    });
    expect(first._unsafeUnwrap()).toEqual({ message: RESEND_VERIFICATION_MESSAGE, retryAfterSeconds: 60 });
    expect(second.isErr()).toBe(true);
    const limited = second._unsafeUnwrapErr();
    expect(limited).toBeInstanceOf(RateLimitedError);
    expect(limited).toMatchObject({ retryAfterSeconds: 50 });
    expect(limited.message).toMatch(/another link in 50 seconds/);
    expect(calls).toEqual(["ada@maple.local"]);
  });

  it("rate limits an address after several different emails from the same network", async () => {
    const store: RateLimitStore = new Map();
    const calls: string[] = [];
    const send = async (email: string) => {
      calls.push(email);
    };
    for (let index = 0; index < 5; index += 1) {
      const result = await resendVerificationNotice({
        email: `person${index}@maple.local`,
        ip: "203.0.113.10",
        store,
        nowMs: 1_000,
        send,
      });
      expect(result.isOk()).toBe(true);
    }
    const blocked = await resendVerificationNotice({
      email: "person6@maple.local",
      ip: "203.0.113.10",
      store,
      nowMs: 2_000,
      send,
    });
    expect(blocked.isErr()).toBe(true);
    expect(blocked._unsafeUnwrapErr()).toBeInstanceOf(RateLimitedError);
    expect(calls).toHaveLength(5);
  });

  it("uses the same message when sending fails", async () => {
    const sent = await resendVerificationNotice({
      email: "ada@maple.local",
      ip: "203.0.113.10",
      store: new Map(),
      nowMs: 0,
      send: async () => undefined,
    });
    const failed = await resendVerificationNotice({
      email: "ada@maple.local",
      ip: "203.0.113.10",
      store: new Map(),
      nowMs: 0,
      send: async () => {
        throw new Error("User not found");
      },
    });
    expect(sent._unsafeUnwrap().message).toBe(failed._unsafeUnwrap().message);
    expect(JSON.stringify(failed._unsafeUnwrap()).includes("not found")).toBe(false);
  });

  it("allows another link after the cooldown window", async () => {
    const store: RateLimitStore = new Map();
    let sends = 0;
    const send = async () => {
      sends += 1;
    };
    await resendVerificationNotice({
      email: "ada@maple.local",
      ip: "203.0.113.10",
      store,
      nowMs: 0,
      send,
    });
    const again = await resendVerificationNotice({
      email: "ada@maple.local",
      ip: "203.0.113.10",
      store,
      nowMs: 60_000,
      send,
    });
    expect(again.isOk()).toBe(true);
    expect(sends).toBe(2);
  });
});

describe("sign-in failure", () => {
  it("uses a distinct unverified message and keeps a wrong password generic", () => {
    const unverified = signInFailureFromCode("EMAIL_NOT_VERIFIED", "Email not verified");
    const wrong = signInFailureFromCode("INVALID_EMAIL_OR_PASSWORD", "Invalid email or password");
    const unknown = signInFailureFromCode(undefined, "Invalid email or password");
    const outage = signInFailureFromCode(undefined, "database exploded");
    expect(unverified).toEqual({ kind: "unverified", message: UNVERIFIED_SIGN_IN_MESSAGE });
    expect(wrong).toEqual({ kind: "generic", message: GENERIC_SIGN_IN_MESSAGE });
    expect(unknown).toEqual(wrong);
    expect(outage.kind).toBe("generic");
    expect(wrong.message).not.toMatch(/verif/i);
    expect(unverified.message).not.toBe(wrong.message);
    expect(unverified.message).toMatch(/verification link/);
  });

  it("treats the provider's unverified message as unverified only when it is exact", () => {
    expect(signInFailureFromCode(undefined, "Email not verified").kind).toBe("unverified");
    expect(signInFailureFromCode(undefined, "Please verify your email").kind).toBe("generic");
  });

  it("explains an expired reset link without repeating the token", () => {
    expect(resetPasswordFailure("INVALID_TOKEN")).toMatch(/expired or was already used/);
    expect(resetPasswordFailure("TOKEN_EXPIRED")).toMatch(/expired or was already used/);
    expect(resetPasswordFailure("PASSWORD_TOO_SHORT")).toMatch(/8 and 128/);
    expect(resetPasswordFailure(undefined)).toMatch(/Ask for a new link/);
  });
});
