import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { requireAgentAccess, type AgentAccess, type AgentGrant } from "@dollas/domain";
import { z, type ZodRawShape } from "zod";

/**
 * The Dollas MCP toolkit. Tools themselves live next to the services they
 * call (apps/web/src/slices/<slice>/tools.ts); this package owns how a tool
 * is described, guarded, paginated, and answered:
 *
 * - every tool declares the access it needs (read, or read and write);
 * - destructive tools declare `destructive` and take `confirm: true`;
 * - results are structured JSON plus a one-line text summary;
 * - failures are the service's member-facing message, never internals.
 */

export type ToolOutcome<T = unknown> = { ok: true; value: T; summary: string } | { ok: false; message: string };

export type ToolDefinition<Ctx, Shape extends ZodRawShape> = {
  /** snake_case, unique. */
  name: string;
  title: string;
  /** What it does, in a sentence or two, including units (integer cents, ISO dates). */
  description: string;
  access: AgentAccess;
  /** Deletes or gives something up. The input must include `confirm: confirmInput(...)`. */
  destructive?: boolean;
  idempotent?: boolean;
  input: Shape;
  run(args: z.infer<z.ZodObject<Shape>>, ctx: Ctx): Promise<ToolOutcome>;
};

/** A tool with its input type erased, so tools with different inputs share one list. */
export type DollasTool<Ctx> = {
  name: string;
  title: string;
  description: string;
  access: AgentAccess;
  destructive?: boolean;
  idempotent?: boolean;
  input: ZodRawShape;
  run(args: Record<string, unknown>, ctx: Ctx): Promise<ToolOutcome>;
};

/** `const tool = toolFor<MyContext>()` then `tool({ ...definition })`. */
export function toolFor<Ctx>() {
  return <Shape extends ZodRawShape>(definition: ToolDefinition<Ctx, Shape>): DollasTool<Ctx> =>
    definition as unknown as DollasTool<Ctx>;
}

export const TOOL_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** The explicit confirmation a destructive tool takes. Only the literal `true` passes. */
export function confirmInput(what: string) {
  return z.literal(true).describe(`Set to true to confirm: ${what}. Ask the member first; this cannot be undone from here.`);
}

export const UNEXPECTED_FAILURE = "Something went wrong in Dollas. Try again.";

export const MAX_PAGE_SIZE = 200;

/** Input fields for a paginated list. */
export function pageInput(defaultLimit: number) {
  return {
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_PAGE_SIZE)
      .optional()
      .describe(`How many to return (1 to ${MAX_PAGE_SIZE}). Defaults to ${defaultLimit}.`),
    cursor: z.string().regex(/^\d{1,9}$/).optional().describe("next_cursor from the previous page."),
  };
}

export type PageRequest = { limit: number; offset: number };

export function readPage(args: { limit?: number; cursor?: string }, defaultLimit: number): PageRequest {
  return { limit: args.limit ?? defaultLimit, offset: args.cursor ? Number(args.cursor) : 0 };
}

export type Page<T> = { items: T[]; total: number; next_cursor: string | null };

/** A page from rows already limited in the query, with the total that matched. */
export function pageFrom<T>(items: T[], total: number, request: PageRequest): Page<T> {
  const end = request.offset + items.length;
  return { items, total, next_cursor: end < total ? String(end) : null };
}

/** A page cut from a complete list. */
export function paginate<T>(all: readonly T[], request: PageRequest): Page<T> {
  return pageFrom(all.slice(request.offset, request.offset + request.limit), all.length, request);
}

export function reply(outcome: ToolOutcome): CallToolResult {
  if (!outcome.ok) return { isError: true, content: [{ type: "text", text: outcome.message }] };
  const structured =
    outcome.value !== null && typeof outcome.value === "object" && !Array.isArray(outcome.value)
      ? (outcome.value as Record<string, unknown>)
      : { result: outcome.value };
  return {
    content: [
      { type: "text", text: outcome.summary },
      { type: "text", text: JSON.stringify(structured) },
    ],
    structuredContent: structured,
  };
}

function hasConfirm(tool: DollasTool<unknown>): boolean {
  const field = tool.input.confirm;
  return field instanceof z.ZodLiteral && field.value === true;
}

/** Throws when a tool list breaks the rules above. The parity test and server construction both call this. */
export function checkToolList(tools: readonly DollasTool<never>[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name)) throw new Error(`Tool name ${tool.name} is not snake_case.`);
    if (seen.has(tool.name)) throw new Error(`Tool ${tool.name} is registered twice.`);
    seen.add(tool.name);
    if (tool.destructive && tool.access !== "write") throw new Error(`Destructive tool ${tool.name} must need write access.`);
    if (tool.destructive && !hasConfirm(tool as DollasTool<unknown>)) {
      throw new Error(`Destructive tool ${tool.name} must take confirm: confirmInput(...).`);
    }
    if (tool.description.trim().length < 20) throw new Error(`Tool ${tool.name} needs a real description.`);
  }
}

export function toolAccessIn(tools: readonly DollasTool<never>[], name: string): AgentAccess | undefined {
  return tools.find((tool) => tool.name === name)?.access;
}

/** Runs one tool for a grant: scope first, then the confirm guard, then the tool. */
export async function runTool<Ctx>(
  tool: DollasTool<Ctx>,
  grant: AgentGrant,
  args: Record<string, unknown>,
  ctx: Ctx,
  onError: (error: unknown, tool: string) => void = () => {},
): Promise<CallToolResult> {
  const allowed = requireAgentAccess(grant, tool.access);
  if (allowed.isErr()) return reply({ ok: false, message: allowed.error.message });
  if (tool.destructive && args.confirm !== true) {
    return reply({ ok: false, message: "This changes or removes something for good. Ask the member, then call again with confirm: true." });
  }
  try {
    return reply(await tool.run(args, ctx));
  } catch (error) {
    onError(error, tool.name);
    return reply({ ok: false, message: UNEXPECTED_FAILURE });
  }
}

export function createDollasMcpServer<Ctx>(
  grant: AgentGrant,
  tools: readonly DollasTool<Ctx>[],
  ctx: Ctx,
  options: { onError?: (error: unknown, tool: string) => void } = {},
): McpServer {
  checkToolList(tools as readonly DollasTool<never>[]);
  const server = new McpServer({ name: "dollas", version: "0.2.0" });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.access === "write" ? `${tool.description} Needs read and write access.` : tool.description,
        inputSchema: tool.input,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.access === "read",
          destructiveHint: tool.access === "write" ? Boolean(tool.destructive) : undefined,
          idempotentHint: tool.idempotent,
          openWorldHint: false,
        },
      },
      (args: Record<string, unknown>) => runTool(tool, grant, args, ctx, options.onError),
    );
  }
  return server;
}
