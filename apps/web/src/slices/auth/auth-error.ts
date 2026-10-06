export function readAuthError(error: unknown): { code?: string; message?: string } {
  if (!error || typeof error !== "object") return {};
  const message = "message" in error && typeof error.message === "string" ? error.message : undefined;
  const body = "body" in error ? error.body : undefined;
  const code =
    body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : undefined;
  return { code, message };
}

export function clientAddress(headerList: Headers): string {
  const forwarded = headerList.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first.slice(0, 64);
  const real = headerList.get("x-real-ip")?.trim();
  if (real) return real.slice(0, 64);
  return "unknown";
}
