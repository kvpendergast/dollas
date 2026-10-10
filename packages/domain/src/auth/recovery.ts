import { err, ok, type Result } from "neverthrow";
import { InvalidAuthEmailError, RateLimitedError } from "../errors";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const FORGOT_PASSWORD_MESSAGE =
  "If that email has a login, we sent a link to choose a new password. The link expires in an hour and works once.";

export const RESEND_VERIFICATION_MESSAGE =
  "If that email still needs a verification link, we sent another one.";

export const GENERIC_SIGN_IN_MESSAGE = "That email and password did not match.";

export const UNVERIFIED_SIGN_IN_MESSAGE =
  "That email still needs a verification link before it can sign in.";

export const FORGOT_PASSWORD_FLOOR_MS = 350;

export const RESEND_WINDOW_MS = 60_000;

const FORGOT_EMAIL_LIMIT = 3;
const FORGOT_EMAIL_WINDOW_MS = 60 * 60 * 1000;
const FORGOT_IP_LIMIT = 8;
const FORGOT_IP_WINDOW_MS = 10 * 60 * 1000;
const RESEND_EMAIL_LIMIT = 1;
const RESEND_IP_LIMIT = 5;
const RESEND_IP_WINDOW_MS = 10 * 60 * 1000;

export type RateBucket = {
  count: number;
  windowStartedAtMs: number;
};

export type RateLimitStore = Map<string, RateBucket>;

export type LimitRule = {
  key: string;
  limit: number;
  windowMs: number;
};

export type SignInFailure = {
  kind: "generic" | "unverified";
  message: string;
};

export function normalizeAuthEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isAuthEmail(value: string): boolean {
  return value.length <= 254 && EMAIL.test(value);
}

export function rateLimitAddress(ip: string): string {
  const trimmed = ip.trim().slice(0, 64);
  return trimmed.length > 0 ? trimmed : "unknown";
}

export function cooldownCopy(retryAfterSeconds: number): string {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  if (seconds < 60) {
    const unit = seconds === 1 ? "second" : "seconds";
    return `You can ask for another link in ${seconds} ${unit}.`;
  }
  const minutes = Math.ceil(seconds / 60);
  const unit = minutes === 1 ? "minute" : "minutes";
  return `You can ask for another link in ${minutes} ${unit}.`;
}

export function signInFailureFromCode(code: string | undefined, message?: string): SignInFailure {
  if (code === "EMAIL_NOT_VERIFIED" || (!code && message === "Email not verified")) {
    return { kind: "unverified", message: UNVERIFIED_SIGN_IN_MESSAGE };
  }
  return { kind: "generic", message: GENERIC_SIGN_IN_MESSAGE };
}

export function resetPasswordFailure(code: string | undefined): string {
  if (code === "INVALID_TOKEN" || code === "TOKEN_EXPIRED") {
    return "That link has expired or was already used. Ask for a new one.";
  }
  if (code === "PASSWORD_TOO_SHORT" || code === "PASSWORD_TOO_LONG") {
    return "Use a password between 8 and 128 characters.";
  }
  return "We could not save that password. Ask for a new link and try again.";
}

function forgotPasswordLimitRules(email: string, ip: string): LimitRule[] {
  return [
    { key: `reset-email:${email}`, limit: FORGOT_EMAIL_LIMIT, windowMs: FORGOT_EMAIL_WINDOW_MS },
    { key: `reset-ip:${rateLimitAddress(ip)}`, limit: FORGOT_IP_LIMIT, windowMs: FORGOT_IP_WINDOW_MS },
  ];
}

export function resendLimitRules(email: string, ip: string): LimitRule[] {
  return [
    { key: `verify-email:${email}`, limit: RESEND_EMAIL_LIMIT, windowMs: RESEND_WINDOW_MS },
    { key: `verify-ip:${rateLimitAddress(ip)}`, limit: RESEND_IP_LIMIT, windowMs: RESEND_IP_WINDOW_MS },
  ];
}

function pruneExpired(store: RateLimitStore, nowMs: number): void {
  if (store.size < 500) return;
  for (const [key, bucket] of store) {
    if (nowMs - bucket.windowStartedAtMs > FORGOT_EMAIL_WINDOW_MS) store.delete(key);
  }
}

export function consumeRateLimit(
  store: RateLimitStore,
  rules: readonly LimitRule[],
  nowMs: number,
): Result<void, RateLimitedError> {
  pruneExpired(store, nowMs);
  const waits: number[] = [];
  for (const rule of rules) {
    const bucket = store.get(rule.key);
    if (!bucket || nowMs - bucket.windowStartedAtMs >= rule.windowMs) continue;
    if (bucket.count < rule.limit) continue;
    const remainingMs = bucket.windowStartedAtMs + rule.windowMs - nowMs;
    waits.push(Math.max(1, Math.ceil(remainingMs / 1000)));
  }
  if (waits.length > 0) {
    const retryAfterSeconds = Math.max(...waits);
    return err(new RateLimitedError(retryAfterSeconds, cooldownCopy(retryAfterSeconds)));
  }
  for (const rule of rules) {
    const bucket = store.get(rule.key);
    if (!bucket || nowMs - bucket.windowStartedAtMs >= rule.windowMs) {
      store.set(rule.key, { count: 1, windowStartedAtMs: nowMs });
      continue;
    }
    bucket.count += 1;
  }
  return ok(undefined);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForSimilarTiming(
  startedMs: number,
  floorMs: number,
  clock: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const remaining = floorMs - (clock() - startedMs);
  if (remaining > 0) await sleep(remaining);
}

export async function requestPasswordResetNotice(input: {
  email: string;
  ip: string;
  store: RateLimitStore;
  nowMs: number;
  requestReset: (email: string) => Promise<void>;
  onRequestFailure?: (error: unknown) => void;
  floorMs?: number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<Result<{ message: string }, InvalidAuthEmailError>> {
  const floorMs = input.floorMs ?? FORGOT_PASSWORD_FLOOR_MS;
  const clock = input.clock ?? Date.now;
  const sleep = input.sleep ?? defaultSleep;
  const started = clock();
  const finish = async <T>(result: T): Promise<T> => {
    await waitForSimilarTiming(started, floorMs, clock, sleep);
    return result;
  };

  const email = normalizeAuthEmail(input.email);
  if (!isAuthEmail(email)) return finish(err(new InvalidAuthEmailError()));

  const permit = consumeRateLimit(input.store, forgotPasswordLimitRules(email, input.ip), input.nowMs);
  if (permit.isOk()) {
    try {
      await input.requestReset(email);
    } catch (error) {
      input.onRequestFailure?.(error);
    }
  }
  return finish(ok({ message: FORGOT_PASSWORD_MESSAGE }));
}

export async function resendVerificationNotice(input: {
  email: string;
  ip: string;
  store: RateLimitStore;
  nowMs: number;
  send: (email: string) => Promise<void>;
  onSendFailure?: (error: unknown) => void;
}): Promise<Result<{ message: string; retryAfterSeconds: number }, InvalidAuthEmailError | RateLimitedError>> {
  const email = normalizeAuthEmail(input.email);
  if (!isAuthEmail(email)) return err(new InvalidAuthEmailError());
  const permit = consumeRateLimit(input.store, resendLimitRules(email, input.ip), input.nowMs);
  if (permit.isErr()) return err(permit.error);
  try {
    await input.send(email);
  } catch (error) {
    input.onSendFailure?.(error);
  }
  return ok({
    message: RESEND_VERIFICATION_MESSAGE,
    retryAfterSeconds: Math.ceil(RESEND_WINDOW_MS / 1000),
  });
}
