const CIPHERTEXT = /v[1-9][0-9]{0,8}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g;
const PLAID_TOKEN = /\b(?:access|public|link)-(?:sandbox|production|development)-[A-Za-z0-9_-]+/g;
const SECRET_ATTRIBUTE = /(token|password|passwd|secret|cipher|credential|authorization|api[-_]?key)/i;
const AUTH_LINK =
  /https?:\/\/\S*(?:\/reset-password\/[A-Za-z0-9._~-]+|\/verify-email\?\S*token=)\S*/gi;

/** Remove connection strings, credential query params, auth links, and sealed bank tokens. */
export function redactSecrets(value: string): string {
  return value
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@[^\s]+/gi, "[redacted-url]")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-url]")
    .replace(AUTH_LINK, "[redacted-link]")
    .replace(/\b(password|pwd|passwd|token|secret)=([^\s&]+)/gi, "$1=[redacted]")
    .replace(CIPHERTEXT, "[redacted-token]")
    .replace(PLAID_TOKEN, "[redacted-token]");
}

/** Drop attributes whose names are secrets, and scrub values that contain them. */
export function redactLogAttributes(attributes: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (SECRET_ATTRIBUTE.test(key)) continue;
    safe[key] = redactSecrets(value);
  }
  return safe;
}
