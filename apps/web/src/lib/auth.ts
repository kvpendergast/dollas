import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { eq } from "drizzle-orm";
import { after } from "next/server";
import { getDb } from "@/db/client";
import { schema, user } from "@/db/schema";
import { redactSecrets } from "@/lib/redact";
import { logError, logInfo } from "@/lib/telemetry";
import { deliverPasswordResetEmail, deliverVerificationEmail } from "@/lib/verification-email";

/** Matches the reset email copy: the link expires in an hour and Better Auth deletes it on use. */
const RESET_PASSWORD_EXPIRES_IN_SECONDS = 60 * 60;

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
export const googleAuthEnabled = Boolean(googleClientId && googleClientSecret);

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
    throw new Error("BETTER_AUTH_SECRET is required");
  }
  return "dollas-local-dev-secret";
}

function deliverResetLinkLater(email: string, url: string): Promise<void> {
  const task = async () => {
    try {
      await deliverPasswordResetEmail({ email, url });
    } catch (error) {
      logError(error, { action: "password-reset-email" });
    }
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
          await deliverVerificationEmail({ email: accountUser.email, url });
        },
      },
      socialProviders: googleAuthEnabled
        ? {
            google: {
              clientId: googleClientId ?? "",
              clientSecret: googleClientSecret ?? "",
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
