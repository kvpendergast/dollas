import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentGrant } from "@dollas/domain";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  UNEXPECTED_FAILURE,
  checkToolList,
  confirmInput,
  createDollasMcpServer,
  pageFrom,
  pageInput,
  paginate,
  readPage,
  toolAccessIn,
  toolFor,
  type DollasTool,
} from "./index";

type Ctx = { household: string };
const tool = toolFor<Ctx>();

const removed = vi.fn(async () => ({ ok: true as const, value: { removed: 1 }, summary: "Removed 1." }));

const tools: DollasTool<Ctx>[] = [
  tool({
    name: "read_thing",
    title: "Read thing",
    description: "Reads a thing from the household books.",
    access: "read",
    input: { ...pageInput(2) },
    run: async (args, ctx) => ({ ok: true, value: paginate([ctx.household, "b", "c"], readPage(args, 2)), summary: "Things." }),
  }),
  tool({
    name: "write_thing",
    title: "Write thing",
    description: "Writes a thing to the household books.",
    access: "write",
    input: { name: z.string() },
    run: async (args) => ({ ok: true, value: { name: args.name }, summary: `Saved ${args.name}.` }),
  }),
  tool({
    name: "remove_thing",
    title: "Remove thing",
    description: "Removes a thing from the household books.",
    access: "write",
    destructive: true,
    input: { confirm: confirmInput("remove the thing") },
    run: removed,
  }),
  tool({
    name: "broken_thing",
    title: "Broken thing",
    description: "Throws, to prove internals never reach the agent.",
    access: "read",
    input: {},
    run: async () => {
      throw new Error("relation \"secret_table\" does not exist");
    },
  }),
];

const grant = (access: "read" | "write"): AgentGrant => ({
  userId: "u1",
  householdId: "h1",
  clientId: "c1",
  access,
  scopes: access === "write" ? ["dollas:read", "dollas:write"] : ["dollas:read"],
});

async function connect(access: "read" | "write") {
  const server = createDollasMcpServer(grant(access), tools, { household: "a" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ text: string }>).map((part) => part.text).join("\n");
}

describe("dollas MCP toolkit", () => {
  it("lists tools with read-only and destructive hints", async () => {
    const client = await connect("read");
    const listed = await client.listTools();
    const byName = new Map(listed.tools.map((item) => [item.name, item]));
    expect(byName.get("read_thing")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("remove_thing")?.annotations?.destructiveHint).toBe(true);
    expect(byName.get("write_thing")?.description).toMatch(/Needs read and write access/);
    expect(toolAccessIn(tools as DollasTool<never>[], "write_thing")).toBe("write");
  });

  it("answers with a summary and structured JSON, and paginates", async () => {
    const client = await connect("read");
    const first = await client.callTool({ name: "read_thing", arguments: {} });
    expect(first.structuredContent).toEqual({ items: ["a", "b"], total: 3, next_cursor: "2" });
    expect(text(first)).toMatch(/^Things\./);
    const second = await client.callTool({ name: "read_thing", arguments: { cursor: "2" } });
    expect(second.structuredContent).toEqual({ items: ["c"], total: 3, next_cursor: null });
  });

  it("refuses write tools for a read grant", async () => {
    const client = await connect("read");
    const result = await client.callTool({ name: "write_thing", arguments: { name: "x" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/read and write/i);
  });

  it("requires confirm: true on destructive tools", async () => {
    const client = await connect("write");
    const missing = await client.callTool({ name: "remove_thing", arguments: {} });
    expect(missing.isError).toBe(true);
    const wrong = await client.callTool({ name: "remove_thing", arguments: { confirm: "yes" } });
    expect(wrong.isError).toBe(true);
    expect(removed).not.toHaveBeenCalled();
    const ok = await client.callTool({ name: "remove_thing", arguments: { confirm: true } });
    expect(ok.isError).toBeFalsy();
    expect(removed).toHaveBeenCalledOnce();
  });

  it("hides unexpected errors", async () => {
    const client = await connect("read");
    const result = await client.callTool({ name: "broken_thing", arguments: {} });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(UNEXPECTED_FAILURE);
  });

  it("rejects tool lists that break the rules", () => {
    const base = tools[1] as DollasTool<never>;
    expect(() => checkToolList([base, base])).toThrow(/twice/);
    expect(() => checkToolList([{ ...base, name: "BadName" }])).toThrow(/snake_case/);
    expect(() => checkToolList([{ ...base, destructive: true }])).toThrow(/confirm/);
    expect(() => checkToolList([{ ...(tools[2] as DollasTool<never>), access: "read" }])).toThrow(/write access/);
  });

  it("pages rows already limited in SQL", () => {
    expect(pageFrom(["x"], 5, { limit: 1, offset: 3 })).toEqual({ items: ["x"], total: 5, next_cursor: "4" });
    expect(pageFrom(["y"], 5, { limit: 1, offset: 4 })).toEqual({ items: ["y"], total: 5, next_cursor: null });
  });
});
