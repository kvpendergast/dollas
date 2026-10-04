import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth";

type AuthHandler = ReturnType<typeof toNextJsHandler>;

export const GET: AuthHandler["GET"] = (request) => toNextJsHandler(getAuth()).GET(request);
export const POST: AuthHandler["POST"] = (request) => toNextJsHandler(getAuth()).POST(request);
