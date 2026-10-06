import { AsyncLocalStorage } from "node:async_hooks";

type Attempt = { mailError?: unknown };

const attempts = new AsyncLocalStorage<Attempt>();

/**
 * Better Auth awaits some mail callbacks and then swallows the rejection.
 * The callback records the failure here so the settings action can still tell
 * the member. Signup throws directly and does not need this store.
 */
export function recordMailFailure(error: unknown): void {
  const current = attempts.getStore();
  if (current && current.mailError === undefined) current.mailError = error;
}

export async function runMailAttempt<T>(
  fn: () => Promise<T>,
): Promise<{ value?: T; error?: unknown; mailError?: unknown }> {
  const attempt: Attempt = {};
  try {
    const value = await attempts.run(attempt, fn);
    return { value, mailError: attempt.mailError };
  } catch (error) {
    return { error, mailError: attempt.mailError };
  }
}
