import { MEMBER_MAIL_FAILURE, MEMBER_RESET_MAIL_FAILURE, memberFacingMessage } from "@dollas/domain";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { describe, it } from "node:test";
import { initTelemetry } from "./telemetry";
import { deliverPasswordResetEmail, deliverVerificationEmail, passwordResetEmailHelp, verificationEmailHelp } from "./verification-email";

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

function captureDir() {
  const lines: string[] = [];
  const original = console.dir;
  console.dir = (item: unknown) => {
    lines.push(inspect(item, { depth: 6 }));
  };
  return {
    lines,
    restore() {
      console.dir = original;
    },
  };
}

const memberLeak = /GOOGLE_CLIENT_|RESEND_|BETTER_AUTH_|BANK_CONNECTION_KEYS|DATABASE_URL|\bResend\b|not configured|server log/i;

function assertMemberSafe(error: unknown) {
  const shown = memberFacingMessage(error, MEMBER_MAIL_FAILURE);
  assert.equal(shown, MEMBER_MAIL_FAILURE);
  assert.equal(memberLeak.test(shown), false);
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

  it("fails on Vercel when either Resend setting is missing and logs the setting names without the link", async () => {
    initTelemetry();
    const info = captureConsole("info");
    const logged = captureDir();
    const fetchLog = captureFetch(() => {
      throw new Error("Resend should not be called");
    });
    try {
      const missingKey = await deliverVerificationEmail(
        { email, url },
        { env: { VERCEL: "1", RESEND_FROM: from } },
      );
      assert.equal(missingKey.isErr(), true);
      if (missingKey.isErr()) {
        assert.match(missingKey.error.message, /RESEND_API_KEY is required to send verification email on Vercel/);
        assertMemberSafe(missingKey.error);
      }
      const missingFrom = await deliverVerificationEmail(
        { email, url },
        { env: { VERCEL_ENV: "preview", RESEND_API_KEY: apiKey } },
      );
      assert.equal(missingFrom.isErr(), true);
      if (missingFrom.isErr()) {
        assert.match(missingFrom.error.message, /RESEND_FROM is required to send verification email on Vercel/);
        assert.equal(missingFrom.error.message.includes(apiKey), false);
        assertMemberSafe(missingFrom.error);
      }
      const missingBoth = await deliverVerificationEmail(
        { email, url },
        { env: { VERCEL_ENV: "production" } },
      );
      assert.equal(missingBoth.isErr(), true);
      if (missingBoth.isErr()) {
        assert.match(
          missingBoth.error.message,
          /RESEND_API_KEY and RESEND_FROM are required to send verification email on Vercel/,
        );
        assertMemberSafe(missingBoth.error);
      }
      assert.deepEqual(fetchLog.calls, []);
      const recorded = [...info.lines, ...logged.lines].join("\n");
      assert.equal(recorded.includes(url), false);
      assert.equal(recorded.includes(apiKey), false);
      assert.match(logged.lines.join("\n"), /RESEND_API_KEY/);
    } finally {
      info.restore();
      logged.restore();
      fetchLog.restore();
    }
  });

  it("fails off Vercel when only one Resend setting is set and does not log the link", async () => {
    const info = captureConsole("info");
    try {
      const result = await deliverVerificationEmail({ email, url }, { env: { RESEND_API_KEY: apiKey } });
      assert.equal(result.isErr(), true);
      if (result.isErr()) {
        assert.match(result.error.message, /RESEND_FROM is required to send verification email\./);
        assert.equal(result.error.message.includes(apiKey), false);
        assertMemberSafe(result.error);
      }
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
      const result = await deliverVerificationEmail(
        { email, url },
        { env: { RESEND_API_KEY: apiKey, RESEND_FROM: from, VERCEL_ENV: "production" } },
      );
      assert.equal(result.isErr(), true);
      if (result.isErr()) {
        assert.equal(result.error instanceof Error, true);
        assert.equal(result.error.message, "Resend could not send the verification email.");
        assert.equal(result.error.message.includes(url), false);
        assert.equal(result.error.message.includes(apiKey), false);
        assertMemberSafe(result.error);
      }
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
      const result = await deliverVerificationEmail(
        { email, url },
        { env: { RESEND_API_KEY: apiKey, RESEND_FROM: from, VERCEL: "1" } },
      );
      assert.equal(result.isErr(), true);
      if (result.isErr()) {
        assert.match(result.error.message, /Resend could not send the verification email: The dollas domain is not verified\./);
        assertMemberSafe(result.error);
      }
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
      const result = await deliverVerificationEmail(
        { email, url },
        { env: { RESEND_API_KEY: apiKey, RESEND_FROM: from } },
      );
      assert.equal(result.isErr(), true);
      if (result.isErr()) {
        assert.match(result.error.message, /Resend could not send the verification email/);
        assertMemberSafe(result.error);
      }
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

  it("tells a member what to do when mail is not configured, without setup details", () => {
    for (const help of [
      verificationEmailHelp({}),
      verificationEmailHelp({ VERCEL_ENV: "production" }),
      verificationEmailHelp({ RESEND_API_KEY: apiKey }),
      verificationEmailHelp({ RESEND_FROM: from, VERCEL: "1" }),
    ]) {
      assert.equal(help, MEMBER_MAIL_FAILURE);
      assert.equal(memberLeak.test(help), false);
      assert.match(help, /help/);
    }
  });
});

describe("password reset page copy", () => {
  it("stays quiet when a reset email can be sent", () => {
    assert.equal(
      passwordResetEmailHelp({ RESEND_API_KEY: apiKey, RESEND_FROM: from, VERCEL_ENV: "production" }),
      "",
    );
  });

  it("shows the same next step when mail is not configured, without setup details", () => {
    for (const help of [
      passwordResetEmailHelp({}),
      passwordResetEmailHelp({ VERCEL: "1" }),
      passwordResetEmailHelp({ RESEND_API_KEY: apiKey }),
      passwordResetEmailHelp({ RESEND_FROM: from, VERCEL_ENV: "preview" }),
    ]) {
      assert.equal(help, MEMBER_RESET_MAIL_FAILURE);
      assert.equal(memberLeak.test(help), false);
      assert.match(help, /reset link/);
      assert.match(help, /help/);
    }
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

  it("fails on Vercel when mail is not configured and keeps that detail out of member copy", async () => {
    const result = await deliverPasswordResetEmail({ email, url: resetUrl }, { env: { VERCEL: "1" } });
    assert.equal(result.isErr(), true);
    if (result.isErr()) {
      assert.match(result.error.message, /RESEND_API_KEY and RESEND_FROM are required to send password reset email on Vercel/);
      assert.equal(result.error.message.includes(resetUrl), false);
      assert.equal(memberFacingMessage(result.error, MEMBER_RESET_MAIL_FAILURE), MEMBER_RESET_MAIL_FAILURE);
      assert.equal(memberLeak.test(MEMBER_RESET_MAIL_FAILURE), false);
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
      const result = await deliverPasswordResetEmail(
        { email, url: resetUrl },
        { env: { RESEND_API_KEY: apiKey, RESEND_FROM: from, VERCEL: "1" } },
      );
      assert.equal(result.isErr(), true);
      if (result.isErr()) {
        assert.equal(result.error instanceof Error, true);
        assert.equal(result.error.message, "Resend could not send the password reset email.");
        assert.equal(result.error.message.includes(resetUrl), false);
        assert.equal(result.error.message.includes(apiKey), false);
        assert.equal(memberFacingMessage(result.error, MEMBER_RESET_MAIL_FAILURE), MEMBER_RESET_MAIL_FAILURE);
        assert.equal(memberLeak.test(memberFacingMessage(result.error, MEMBER_RESET_MAIL_FAILURE)), false);
      }
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
