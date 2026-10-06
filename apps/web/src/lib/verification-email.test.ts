import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deliverPasswordResetEmail, deliverVerificationEmail, verificationEmailHelp } from "./verification-email";

const email = "ada@maple.local";
const url = "http://localhost:3000/api/auth/verify-email?token=seed-token&callbackURL=/welcome";
const apiKey = "test-resend-key";
const from = "Dollas <verify@dollas.test>";

type CapturedRequest = {
  href: string;
  method: string;
  authorization: string;
  body: Record<string, unknown>;
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function captureFetch(responseFor: (call: CapturedRequest) => Response | Promise<Response>) {
  const calls: CapturedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    const rawBody = typeof init?.body === "string" ? init.body : "";
    const call: CapturedRequest = {
      href,
      method,
      authorization: headers.get("authorization") ?? "",
      body: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {},
    };
    calls.push(call);
    return responseFor(call);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

function captureConsole(method: "info" | "error" | "log" | "debug") {
  const lines: string[] = [];
  const original = console[method];
  console[method] = (...args: unknown[]) => {
    lines.push(
      args
        .map((arg) => {
          if (typeof arg === "string") return arg;
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        })
        .join(" "),
    );
  };
  return {
    lines,
    restore() {
      console[method] = original;
    },
  };
}

function setNodeEnv(value: string | undefined): void {
  const env = process.env as { NODE_ENV?: string };
  if (value === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = value;
}

function recipient(to: unknown): string[] {
  if (typeof to === "string") return [to];
  if (Array.isArray(to)) return to.map(String);
  return [];
}

describe("verification email", () => {
  it("sends the link through Resend and does not write it to the server log", async () => {
    const info = captureConsole("info");
    const errorLog = captureConsole("error");
    const fetchLog = captureFetch(() => jsonResponse(200, { id: "email_123" }));
    const previousNodeEnv = process.env.NODE_ENV;
    setNodeEnv("production");
    try {
      await deliverVerificationEmail(
        { email, url },
        {
          env: {
            RESEND_API_KEY: `  ${apiKey}  `,
            RESEND_FROM: `  ${from}  `,
            VERCEL_ENV: "production",
            VERCEL: "1",
          },
        },
      );
      assert.equal(fetchLog.calls.length, 1);
      const call = fetchLog.calls[0];
      assert.equal(call?.href, "https://api.resend.com/emails");
      assert.equal(call?.method, "POST");
      assert.equal(call?.authorization, `Bearer ${apiKey}`);
      assert.equal(call?.body.from, from);
      assert.deepEqual(recipient(call?.body.to), [email]);
      assert.match(String(call?.body.subject), /dollas/);
      assert.match(String(call?.body.text), /dollas/);
      assert.equal(String(call?.body.text).includes(url), true);
      const logged = [...info.lines, ...errorLog.lines].join("\n");
      assert.equal(logged.includes(url), false);
      assert.equal(logged.includes(apiKey), false);
      assert.equal(logged.includes(String(call?.body.text)), false);
    } finally {
      setNodeEnv(previousNodeEnv);
      info.restore();
      errorLog.restore();
      fetchLog.restore();
    }
  });

  it("writes the link to the server log when Resend is unset off Vercel", async () => {
    const info = captureConsole("info");
    const fetchLog = captureFetch(() => {
      throw new Error("Resend should not be called");
    });
    try {
      await deliverVerificationEmail({ email, url }, { env: {} });
      assert.deepEqual(fetchLog.calls, []);
      assert.deepEqual(info.lines, [`Verify ${email}: ${url}`]);
    } finally {
      info.restore();
      fetchLog.restore();
    }
  });

  it("treats blank Resend settings as unset for local development", async () => {
    const info = captureConsole("info");
    try {
      await deliverVerificationEmail(
        { email, url },
        { env: { RESEND_API_KEY: "  ", RESEND_FROM: "" } },
      );
      assert.deepEqual(info.lines, [`Verify ${email}: ${url}`]);
    } finally {
      info.restore();
    }
  });

  it("fails on Vercel when either Resend setting is missing and does not log the link", async () => {
    const info = captureConsole("info");
    const fetchLog = captureFetch(() => {
      throw new Error("Resend should not be called");
    });
    try {
      await assert.rejects(
        () => deliverVerificationEmail({ email, url }, { env: { VERCEL: "1", RESEND_FROM: from } }),
        /RESEND_API_KEY is required to send verification email on Vercel/,
      );
      await assert.rejects(
        () =>
          deliverVerificationEmail(
            { email, url },
            { env: { VERCEL_ENV: "preview", RESEND_API_KEY: apiKey } },
          ),
        /RESEND_FROM is required to send verification email on Vercel/,
      );
      await assert.rejects(
        () => deliverVerificationEmail({ email, url }, { env: { VERCEL_ENV: "production" } }),
        /RESEND_API_KEY and RESEND_FROM are required to send verification email on Vercel/,
      );
      assert.deepEqual(fetchLog.calls, []);
      assert.equal(info.lines.join("\n").includes(url), false);
    } finally {
      info.restore();
      fetchLog.restore();
    }
  });

  it("fails off Vercel when only one Resend setting is set and does not log the link", async () => {
    const info = captureConsole("info");
    try {
      await assert.rejects(
        () => deliverVerificationEmail({ email, url }, { env: { RESEND_API_KEY: apiKey } }),
        /RESEND_FROM is required to send verification email\./,
      );
      assert.equal(info.lines.join("\n").includes(url), false);
    } finally {
      info.restore();
    }
  });

  it("fails when Resend returns an error and keeps the link and API key out of the error and the log", async () => {
    const info = captureConsole("info");
    const errorLog = captureConsole("error");
    const fetchLog = captureFetch(() =>
      jsonResponse(422, {
        name: "validation_error",
        statusCode: 422,
        message: `Invalid from address. Body was ${url} using ${apiKey}`,
      }),
    );
    const previousNodeEnv = process.env.NODE_ENV;
    setNodeEnv("production");
    try {
      await assert.rejects(
        () =>
          deliverVerificationEmail(
            { email, url },
            { env: { RESEND_API_KEY: apiKey, RESEND_FROM: from, VERCEL_ENV: "production" } },
          ),
        (error: unknown) => {
          assert.equal(error instanceof Error, true);
          const message = error instanceof Error ? error.message : "";
          assert.equal(message, "Resend could not send the verification email.");
          assert.equal(message.includes(url), false);
          assert.equal(message.includes(apiKey), false);
          return true;
        },
      );
      const logged = [...info.lines, ...errorLog.lines].join("\n");
      assert.equal(logged.includes(url), false);
      assert.equal(logged.includes(apiKey), false);
    } finally {
      setNodeEnv(previousNodeEnv);
      info.restore();
      errorLog.restore();
      fetchLog.restore();
    }
  });

  it("includes a Resend error that does not contain the link", async () => {
    const fetchLog = captureFetch(() =>
      jsonResponse(403, {
        name: "validation_error",
        statusCode: 403,
        message: "The dollas domain is not verified",
      }),
    );
    const previousNodeEnv = process.env.NODE_ENV;
    setNodeEnv("production");
    try {
      await assert.rejects(
        () =>
          deliverVerificationEmail(
            { email, url },
            { env: { RESEND_API_KEY: apiKey, RESEND_FROM: from, VERCEL: "1" } },
          ),
        /Resend could not send the verification email: The dollas domain is not verified\./,
      );
    } finally {
      setNodeEnv(previousNodeEnv);
      fetchLog.restore();
    }
  });

  it("fails when Resend cannot be reached", async () => {
    const fetchLog = captureFetch(() => {
      throw new Error("network down");
    });
    const previousNodeEnv = process.env.NODE_ENV;
    setNodeEnv("production");
    try {
      await assert.rejects(
        () =>
          deliverVerificationEmail(
            { email, url },
            { env: { RESEND_API_KEY: apiKey, RESEND_FROM: from } },
          ),
        /Resend could not send the verification email/,
      );
    } finally {
      setNodeEnv(previousNodeEnv);
      fetchLog.restore();
    }
  });

  it("tells a configured user to check their inbox", () => {
    const help = verificationEmailHelp({
      RESEND_API_KEY: apiKey,
      RESEND_FROM: from,
      VERCEL_ENV: "production",
    });
    assert.match(help, /inbox/);
    assert.match(help, /dollas/);
    assert.equal(help.includes("server log"), false);
  });

  it("mentions the server log only as the local fallback when Resend is not configured", () => {
    const local = verificationEmailHelp({});
    assert.match(local, /server log/);
    assert.match(local, /Resend is not configured/);
    const hosted = verificationEmailHelp({ VERCEL_ENV: "production" });
    assert.equal(hosted.includes("server log"), false);
    assert.match(hosted, /could not be sent/);
  });
});

const resetUrl = "http://localhost:3000/api/auth/reset-password/reset-token-value?callbackURL=%2Freset-password";

describe("password reset email", () => {
  it("sends the link through Resend and does not write it to the server log", async () => {
    const info = captureConsole("info");
    const errorLog = captureConsole("error");
    const fetchLog = captureFetch(() => jsonResponse(200, { id: "email_reset" }));
    const previousNodeEnv = process.env.NODE_ENV;
    setNodeEnv("production");
    try {
      await deliverPasswordResetEmail(
        { email, url: resetUrl },
        { env: { RESEND_API_KEY: apiKey, RESEND_FROM: from, VERCEL_ENV: "production", VERCEL: "1" } },
      );
      assert.equal(fetchLog.calls.length, 1);
      const call = fetchLog.calls[0];
      assert.equal(call?.body.from, from);
      assert.deepEqual(recipient(call?.body.to), [email]);
      assert.match(String(call?.body.subject), /password/i);
      assert.equal(String(call?.body.text).includes(resetUrl), true);
      assert.match(String(call?.body.text), /works once/);
      const logged = [...info.lines, ...errorLog.lines].join("\n");
      assert.equal(logged.includes(resetUrl), false);
      assert.equal(logged.includes("reset-token-value"), false);
      assert.equal(logged.includes(apiKey), false);
    } finally {
      setNodeEnv(previousNodeEnv);
      info.restore();
      errorLog.restore();
      fetchLog.restore();
    }
  });

  it("writes the reset link to the server log when Resend is unset off Vercel", async () => {
    const info = captureConsole("info");
    const fetchLog = captureFetch(() => {
      throw new Error("Resend should not be called");
    });
    try {
      await deliverPasswordResetEmail({ email, url: resetUrl }, { env: {} });
      assert.deepEqual(fetchLog.calls, []);
      assert.deepEqual(info.lines, [`Reset password for ${email}: ${resetUrl}`]);
    } finally {
      info.restore();
      fetchLog.restore();
    }
  });

  it("keeps the reset link out of a Resend failure", async () => {
    const info = captureConsole("info");
    const errorLog = captureConsole("error");
    const fetchLog = captureFetch(() =>
      jsonResponse(422, { message: `Invalid from address. Body was ${resetUrl} using ${apiKey}` }),
    );
    const previousNodeEnv = process.env.NODE_ENV;
    setNodeEnv("production");
    try {
      await assert.rejects(
        () =>
          deliverPasswordResetEmail(
            { email, url: resetUrl },
            { env: { RESEND_API_KEY: apiKey, RESEND_FROM: from, VERCEL: "1" } },
          ),
        (error: unknown) => {
          assert.equal(error instanceof Error, true);
          const message = error instanceof Error ? error.message : "";
          assert.equal(message, "Resend could not send the password reset email.");
          assert.equal(message.includes(resetUrl), false);
          assert.equal(message.includes(apiKey), false);
          return true;
        },
      );
      const logged = [...info.lines, ...errorLog.lines].join("\n");
      assert.equal(logged.includes(resetUrl), false);
      assert.equal(logged.includes("reset-token-value"), false);
    } finally {
      setNodeEnv(previousNodeEnv);
      info.restore();
      errorLog.restore();
      fetchLog.restore();
    }
  });
});
