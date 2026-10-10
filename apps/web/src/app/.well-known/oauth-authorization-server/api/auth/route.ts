import { authorizationServerMetadataResponse } from "@/slices/agents/metadata";

export const dynamic = "force-dynamic";

export const GET = (request: Request) => authorizationServerMetadataResponse(request);
