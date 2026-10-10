import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { accountTypes, requireAgentAccess, type AgentAccess, type AgentGrant } from "@dollas/domain";
import { z } from "zod";

/**
 * Dollas MCP tools. This package owns tool names, schemas, and scope rules;
 * the web app supplies the services, which are the same server functions its
 * pages call, already bound to the member and household from the access token.
 *
 * Bank passwords, provider keys, and finishing a bank login are UI-only and
 * have no tool here. PEN-207 adds the rest of the tool set.
 */

export type ToolOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

export type WhoAmI = {
  member: { name: string; role: "owner" | "member" };
  household: { name: string; currency: string; timezone: string };
  access: AgentAccess;
};

export type AccountSummary = {
  id: string;
  name: string;
  type: string;
  balanceCents: number;
  archived: boolean;
};

export type AddAccountInput = {
  name: string;
  type: string;
  opening: string;
  owed: boolean;
};

export type AddedAccount = {
  id: string;
  name: string;
  type: string;
  openingBalanceCents: number;
};

export type DollasMcpServices = {
  whoami(): Promise<ToolOutcome<WhoAmI>>;
  listAccounts(input: { includeArchived: boolean }): Promise<ToolOutcome<AccountSummary[]>>;
  addAccount(input: AddAccountInput): Promise<ToolOutcome<AddedAccount>>;
};

/** Every tool and the access it needs. The HTTP layer uses this for 403 step-up. */
export const DOLLAS_TOOL_ACCESS = {
  whoami: "read",
  list_accounts: "read",
  add_account: "write",
} as const satisfies Record<string, AgentAccess>;

export type DollasToolName = keyof typeof DOLLAS_TOOL_ACCESS;

export function toolAccess(name: string): AgentAccess | undefined {
  return Object.hasOwn(DOLLAS_TOOL_ACCESS, name) ? DOLLAS_TOOL_ACCESS[name as DollasToolName] : undefined;
}

function reply<T>(outcome: ToolOutcome<T>): CallToolResult {
  if (!outcome.ok) return { isError: true, content: [{ type: "text", text: outcome.message }] };
  const structured = Array.isArray(outcome.value) ? { items: outcome.value } : (outcome.value as Record<string, unknown>);
  return { content: [{ type: "text", text: JSON.stringify(outcome.value) }], structuredContent: structured };
}

/** Runs a tool only when the grant has the access the tool needs. */
async function guarded<T>(grant: AgentGrant, name: DollasToolName, run: () => Promise<ToolOutcome<T>>): Promise<CallToolResult> {
  const allowed = requireAgentAccess(grant, DOLLAS_TOOL_ACCESS[name]);
  if (allowed.isErr()) return reply({ ok: false, message: allowed.error.message });
  return reply(await run());
}

export function createDollasMcpServer(grant: AgentGrant, services: DollasMcpServices): McpServer {
  const server = new McpServer({ name: "dollas", version: "0.1.0" });

  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description: "The member this agent acts as, their household, and whether the agent can read or also write.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => guarded(grant, "whoami", () => services.whoami()),
  );

  server.registerTool(
    "list_accounts",
    {
      title: "List accounts",
      description:
        "Accounts in the household books with balances in integer cents (negative means owed). Archived accounts are left out unless asked for.",
      inputSchema: { include_archived: z.boolean().optional().describe("Include archived accounts.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => guarded(grant, "list_accounts", () => services.listAccounts({ includeArchived: args.include_archived ?? false })),
  );

  server.registerTool(
    "add_account",
    {
      title: "Add account",
      description:
        "Add a manual account to the household books. Needs read and write access. Opening balance is decimal text such as 1250.00; for credit, set owed when the amount is owed.",
      inputSchema: {
        name: z.string().min(1).max(80).describe("Account name."),
        type: z.enum(accountTypes).describe("Account type."),
        opening_balance: z.string().max(20).optional().describe("Opening balance as decimal text. Defaults to 0."),
        owed: z.boolean().optional().describe("Credit only: the opening balance is owed."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      guarded(grant, "add_account", () =>
        services.addAccount({
          name: args.name,
          type: args.type,
          opening: args.opening_balance ?? "0",
          owed: args.owed ?? false,
        }),
      ),
  );

  return server;
}
