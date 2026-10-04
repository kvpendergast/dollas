import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDollasMcpServer } from "./index";

const server = createDollasMcpServer();
await server.connect(new StdioServerTransport());
