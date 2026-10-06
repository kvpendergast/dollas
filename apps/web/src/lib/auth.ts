import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { ConfigError, MEMBER_MAIL_FAILURE, memberFacingMessage, resolveGoogleSignIn } from "@dollas/domain";
import { eq } from "drizzle-orm";
import { after } from "next/server";
import { getDb } from "@/db/client";
import { schema, user } from "@/db/schema";
import { redactSecrets } from "@/lib/redact";
import { logError, logInfo } from "@/lib/telemetry";
import { deliverPasswordResetEmail, deliverVerificationEmail } from "@/lib/verification-email";

/** Matches the reset email copy: the link expires in an hour and Better Auth deletes it on use. */
const RESET_PASSWORD_EXPIRES_IN_SECONDS = 60 * 60;

type Env = Record<string, string | undefined>;

let reportedIncompleteGoogle = false;

/** Server decision. The client receives only this boolean, never the credentials. */
export function googleSignInEnabled(env: Env = process.env): boolean {
  const decision = resolveGoogleSignIn({
    clientId: env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
  });
  if (decision.isErr()) {
    if (!reportedIncompleteGoogle) {
      reportedIncompleteGoogle = true;
      logError(decision.error, { action: "google-sign-in" });
    }
    return false;
  }
  return decision.value.enabled;
}

function authBaseURL() {
  if (process.env.BETTER_AUTH_URL) return process.env.BETTER_AUTH_URL;
  if (process.env.VERCEL_ENV === "production" && process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return "http://localhost:3000";
}

function authSecret() {
  if (process.env.BETTER_AUTH_SECRET) return process.env.BETTER_AUTH_SECRET;
  if (process.env.VERCEL_ENV) {
    throw new ConfigError("BETTER_AUTH_SECRET is required");
  }
  return "dollas-local-dev-secret";
}

function deliverResetLinkLater(email: string, url: string): Promise<void> {
  const task = async () => {
    const sent = await deliverPasswordResetEmail({ email, url });
    if (sent.isErr()) return;
  };
  try {
    after(task);
  } catch (error) {
    logError(error, { action: "password-reset-schedule" });
    return task();
  }
  return Promise.resolve();
}

function createAuth() {
  return betterAuth({
      appName: "dollas",
      baseURL: authBaseURL(),
      secret: authSecret(),
      database: drizzleAdapter(getDb(), {
        provider: "pg",
        schema,
        camelCase: true,
      }),
      logger: {
        log(level, message, ...args) {
          const text = typeof message === "string" ? message : "";
          if (/user not found/i.test(text)) return;
          const safe = typeof message === "string" ? redactSecrets(message) : message;
          if (level === "error") console.error(safe, ...args);
          else if (level === "warn") console.warn(safe, ...args);
          else console.info(safe, ...args);
        },
      },
      // HTTP routes are limited per IP. Server actions call auth.api directly, which
      // skips this hook, so the auth slice also limits resend and reset per email and IP.
      rateLimit: {
        enabled: true,
      },
      emailAndPassword: {
        enabled: true,
        requireEmailVerification: true,
        revokeSessionsOnPasswordReset: true,
        resetPasswordTokenExpiresIn: RESET_PASSWORD_EXPIRES_IN_SECONDS,
        sendResetPassword: async ({ user: accountUser, url }) => {
          await deliverResetLinkLater(accountUser.email, url);
        },
      },
      emailVerification: {
        sendOnSignUp: true,
        sendOnSignIn: true,
        autoSignInAfterVerification: true,
        sendVerificationEmail: async ({ user: accountUser, url }) => {
          const sent = await deliverVerificationEmail({ email: accountUser.email, url });
          if (sent.isErr()) {
            throw new Error(memberFacingMessage(sent.error, MEMBER_MAIL_FAILURE));
          }
        },
      },
      socialProviders: googleSignInEnabled()
        ? {
            google: {
              clientId: process.env.GOOGLE_CLIENT_ID?.trim() ?? "",
              clientSecret: process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "",
            },
          }
        : undefined,
      databaseHooks: {
        account: {
          create: {
            after: async (created) => {
              if (created.providerId !== "google") return;
              await getDb()
                .update(user)
                .set({ emailVerified: true, updatedAt: new Date() })
                .where(eq(user.id, created.userId));
              logInfo("Google sign-in counts as a verified email", { userId: created.userId });
            },
          },
        },
      },
      plugins: [nextCookies()],
    });
}

let cached: ReturnType<typeof createAuth> | undefined;

export function getAuth() {
  cached ??= createAuth();
  return cached;
}
