import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { serverSecret } from "./server-secret";

describe("serverSecret", () => {
  it("uses the configured secret everywhere", () => {
    assert.equal(serverSecret({ BETTER_AUTH_SECRET: " s3cret-value-for-tests " }), "s3cret-value-for-tests");
    assert.equal(serverSecret({ BETTER_AUTH_SECRET: "s3cret", NODE_ENV: "production" }), "s3cret");
  });

  it("falls back to the development value only outside hosted runs", () => {
    assert.ok(serverSecret({}));
    assert.ok(serverSecret({ NODE_ENV: "development" }));
    assert.ok(serverSecret({ NODE_ENV: "test" }));
  });

  it("refuses to start a hosted process without a secret (self-host, next start, Docker)", () => {
    assert.throws(() => serverSecret({ NODE_ENV: "production" }), /BETTER_AUTH_SECRET is required/);
    assert.throws(() => serverSecret({ NODE_ENV: "production", BETTER_AUTH_SECRET: "  " }), /BETTER_AUTH_SECRET is required/);
    assert.throws(() => serverSecret({ VERCEL_ENV: "preview" }), /BETTER_AUTH_SECRET is required/);
  });

  it("refuses the public development value on a hosted process", () => {
    const dev = serverSecret({});
    assert.throws(() => serverSecret({ NODE_ENV: "production", BETTER_AUTH_SECRET: dev }), /public development value/);
    assert.throws(() => serverSecret({ VERCEL_ENV: "production", BETTER_AUTH_SECRET: dev }), /public development value/);
  });
});
