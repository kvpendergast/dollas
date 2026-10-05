import type { Instrumentation } from "next";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { initTelemetry } = await import("./lib/telemetry");
    initTelemetry();
  } catch (error) {
    console.error(`Telemetry init failed: ${startupErrorText(error)}`);
  }
  const { migrateOnStartup } = await import("./db/apply-migrations");
  await migrateOnStartup();
  const { requireBankConnectionKeys } = await import("./slices/connections/keys");
  try {
    requireBankConnectionKeys();
  } catch (error) {
    const { logError } = await import("./lib/telemetry");
    logError(error, { action: "bank-connection-keys" });
    throw error;
  }
}

function startupErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-url]");
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { logError } = await import("./lib/telemetry");
  const digest = typeof error === "object" && error !== null && "digest" in error ? String(error.digest) : "";
  logError(error, {
    "http.path": request.path,
    "http.method": request.method,
    "next.route": context.routePath,
    "next.route_type": context.routeType,
    "error.digest": digest,
  });
};
