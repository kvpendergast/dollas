import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { schema, user } from "@/db/schema";
import { logInfo } from "@/lib/telemetry";
import { deliverVerificationEmail } from "@/lib/verification-email";

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
      emailAndPassword: {
        enabled: true,
        requireEmailVerification: true,
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
