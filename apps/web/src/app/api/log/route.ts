import { logError } from "@/lib/telemetry";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { message?: unknown; digest?: unknown } | null;
  const message = typeof body?.message === "string" ? body.message.slice(0, 500) : "Client error";
  const digest = typeof body?.digest === "string" ? body.digest.slice(0, 120) : "";
  logError(new Error(message), { source: "browser", "error.digest": digest });
  return Response.json({ ok: true });
}
