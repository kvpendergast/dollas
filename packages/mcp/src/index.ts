import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * MCP slot for dollas. No tools are registered in this pass.
 * Later tools can read the same household books once bank linking exists.
 */
export function createDollasMcpServer(): McpServer {
  return new McpServer({
    name: "dollas",
    version: "0.0.1",
  });
}
