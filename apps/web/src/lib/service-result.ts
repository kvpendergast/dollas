import { DomainError, memberFacingMessage } from "@dollas/domain";
import { logError } from "@/lib/telemetry";

/**
 * The plain result every shared server service returns. Page actions and MCP
 * tools both unwrap it; neverthrow stays inside @dollas/domain.
 */
export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: unknown; memberMessage: string };

/** Who is acting. Every service runs as this member through household RLS. */
export type ServiceActor = {
  userId: string;
  householdId: string;
};

export type Via = "web" | "mcp";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function succeed<T>(value: T): ServiceResult<T> {
  return { ok: true, value };
}

/** A refusal the member can act on. Not logged as an error. */
export function refuse(message: string, error: unknown = new Error(message)): ServiceResult<never> {
  return { ok: false, error, memberMessage: message };
}

/**
 * Turns a thrown error into a member-facing result. Domain errors and the
 * listed known messages are shown as they are; anything else (SQL, network)
 * shows the fallback so internals never reach a member or an agent.
 */
export function failure(
  error: unknown,
  fallback: string,
  attributes: Record<string, string>,
  known: ReadonlySet<string> | readonly string[] = [],
): ServiceResult<never> {
  const knownSet = known instanceof Set ? known : new Set(known as readonly string[]);
  logError(error, attributes);
  if (error instanceof DomainError) {
    return { ok: false, error, memberMessage: memberFacingMessage(error, fallback) };
  }
  if (error instanceof Error && knownSet.has(error.message)) {
    return { ok: false, error, memberMessage: error.message };
  }
  return { ok: false, error, memberMessage: fallback };
}
