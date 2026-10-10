import { handleMcpRequest } from "@/slices/agents/mcp";

export const dynamic = "force-dynamic";

export const POST = (request: Request) => handleMcpRequest(request);
export const GET = (request: Request) => handleMcpRequest(request);
export const DELETE = (request: Request) => handleMcpRequest(request);
