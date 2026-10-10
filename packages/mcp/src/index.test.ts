import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentGrant } from "@dollas/domain";
import { describe, expect, it, vi } from "vitest";
import { DOLLAS_TOOL_ACCESS, createDollasMcpServer, toolAccess, type DollasMcpServices } from "./index";

function services(): DollasMcpServices & { addAccount: ReturnType<typeof vi.fn> } {
  return {
    whoami: async () => ({
      ok: true,
      value: {
        member: { name: "Ada", role: "owner" },
        household: { name: "Maple", currency: "USD", timezone: "UTC" },
        access: "read",
      },
    }),
    listAccounts: async () => ({ ok: true, value: [{ id: "a1", name: "Checking", type: "checking", balanceCents: 1200, archived: false }] }),
    addAccount: vi.fn(async () => ({ ok: true as const, value: { id: "a2", name: "Cash", type: "cash", openingBalanceCents: 0 } })),
  };
}

const grant = (access: "read" | "write"): AgentGrant => ({
  userId: "u1",
  householdId: "h1",
  clientId: "c1",
  access,
  scopes: access === "write" ? ["dollas:read", "dollas:write"] : ["dollas:read"],
});

async function connect(access: "read" | "write", impl = services()) {
  const server = createDollasMcpServer(grant(access), impl);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, impl };
}

describe("dollas MCP tools", () => {
  it("names every tool's access", () => {
    expect(DOLLAS_TOOL_ACCESS).toEqual({ whoami: "read", list_accounts: "read", add_account: "write" });
    expect(toolAccess("add_account")).toBe("write");
    expect(toolAccess("toString")).toBeUndefined();
  });

  it("lists exactly the minimal tool set, with no credential tools", async () => {
    const { client } = await connect("read");
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["add_account", "list_accounts", "whoami"]);
    expect(JSON.stringify(tools)).not.toMatch(/password|secret|provider_token|plaid/i);
  });

  it("runs read tools with integer cents", async () => {
    const { client } = await connect("read");
    const result = await client.callTool({ name: "list_accounts", arguments: {} });
    expect(result.structuredContent).toEqual({
      items: [{ id: "a1", name: "Checking", type: "checking", balanceCents: 1200, archived: false }],
    });
  });

  it("refuses the write tool for a read grant even if the HTTP check is bypassed", async () => {
    const { client, impl } = await connect("read");
    const result = await client.callTool({ name: "add_account", arguments: { name: "Cash", type: "cash" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/read and write/);
    expect(impl.addAccount).not.toHaveBeenCalled();
  });

  it("runs the write tool for a write grant", async () => {
    const { client, impl } = await connect("write");
    const result = await client.callTool({ name: "add_account", arguments: { name: "Cash", type: "cash", opening_balance: "5" } });
    expect(result.isError).toBeFalsy();
    expect(impl.addAccount).toHaveBeenCalledWith({ name: "Cash", type: "cash", opening: "5", owed: false });
  });
});
