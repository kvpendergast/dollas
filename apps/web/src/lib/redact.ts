const CIPHERTEXT = /v[1-9][0-9]{0,8}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g;
const SECRET_ATTRIBUTE = /(token|password|passwd|secret|cipher|credential|authorization|api[-_]?key)/i;

/** Remove connection strings, credential query params, and sealed bank tokens. */
export function redactSecrets(value: string): string {
  return value
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted-url]")
    .replace(/\b(password|pwd|passwd|token|secret)=([^\s&]+)/gi, "$1=[redacted]")
    .replace(CIPHERTEXT, "[redacted-token]");
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
