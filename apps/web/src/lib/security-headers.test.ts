import assert from "node:assert/strict";
import { describe, it } from "node:test";
import nextConfig, { SECURITY_HEADERS } from "../../next.config";

describe("security headers", () => {
  it("applies to every path and blocks framing (consent page clickjacking)", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    const all = rules.find((rule) => rule.source === "/:path*");
    assert.ok(all, "a rule covers every path");
    const byKey = new Map(all.headers.map((header) => [header.key, header.value]));
    assert.equal(byKey.get("X-Frame-Options"), "DENY");
    assert.match(byKey.get("Content-Security-Policy") ?? "", /frame-ancestors 'none'/);
    assert.equal(byKey.get("X-Content-Type-Options"), "nosniff");
    assert.ok(byKey.get("Referrer-Policy"));
    assert.match(byKey.get("Strict-Transport-Security") ?? "", /max-age=\d{7,}/);
    assert.equal(all.headers.length, SECURITY_HEADERS.length);
  });
});
