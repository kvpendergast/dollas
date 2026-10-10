import { toolFor, type ToolOutcome } from "@dollas/mcp";
import { formatCents, type AgentGrant } from "@dollas/domain";
import { z } from "zod";
import type { ServiceResult } from "@/lib/service-result";
import type { BooksContext } from "@/slices/access/member";

/**
 * What every Dollas tool receives: the member and household from the access
 * token (already checked against membership) and the grant. Tools pass
 * `books` to the same services the pages call, with via "mcp".
 */
export type AgentToolContext = {
  books: BooksContext;
  grant: AgentGrant;
};

export const tool = toolFor<AgentToolContext>();

/** camelCase keys to snake_case, deeply. Values are left alone. Tool output is always snake_case. */
export function snakeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeKeys);
  if (value instanceof Date) return value.toISOString();
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), snakeKeys(inner)]),
  );
}

/**
 * A service result as a tool outcome: the (optionally reshaped) value with
 * snake_case keys plus a one-line summary, or the member-facing message.
 */
export function answer<T, V = T>(
  result: ServiceResult<T>,
  summarize: (value: T) => string,
  shape?: (value: T) => V,
): ToolOutcome {
  if (!result.ok) return { ok: false, message: result.memberMessage };
  return { ok: true, value: snakeKeys(shape ? shape(result.value) : result.value), summary: summarize(result.value) };
}

export const uuidInput = (what: string) => z.string().uuid().describe(`${what} id.`);

export const isoDateInput = (what: string) =>
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(`${what} as an ISO date, YYYY-MM-DD.`);

export const monthInput = z
  .string()
  .regex(/^\d{4}-\d{2}$/)
  .describe("Plan month as YYYY-MM. Defaults to the household's current month.");

/** Whole cents, e.g. 125000 for $1,250.00. */
export const centsInput = (what: string) => z.number().int().safe().describe(`${what} in integer cents.`);

/** Decimal text the account rules parse, from whole cents. Exact for any integer. */
export function decimalText(cents: number): string {
  const abs = Math.abs(cents);
  return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function money(cents: number, books: Pick<BooksContext, "currency">): string {
  return formatCents(cents, books.currency);
}
