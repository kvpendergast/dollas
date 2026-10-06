import { err, ok, type Result } from "neverthrow";
import { ConfigError, DomainError, MailDeliveryError, TokenEncryptionError } from "../errors";

/** Plain next step when the app itself is not ready. No setup instructions. */
export const MEMBER_SETUP_FAILURE =
  "We could not finish that just now. Try again in a little while, or ask the person who runs this app for help.";

/** Plain next step when a verification email could not be sent. */
export const MEMBER_MAIL_FAILURE =
  "We could not email you a verification link. Try again in a little while, or ask the person who runs this app for help.";

/** Plain next step when a password-reset email could not be sent. */
export const MEMBER_RESET_MAIL_FAILURE =
  "We could not email you a reset link. Try again in a little while, or ask the person who runs this app for help.";

/** Plain next step when a verification email was handed to the mailer. */
export const MEMBER_MAIL_READY =
  "Check your inbox for a verification message from dollas and open the link, then come back and sign in.";

const SETUP_LEAK =
  /\b(?:GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|RESEND_API_KEY|RESEND_FROM|BETTER_AUTH_SECRET|BETTER_AUTH_URL|DATABASE_URL|DATABASE_MIGRATE_URL|DATABASE_URL_UNPOOLED|BANK_CONNECTION_KEYS|PLAID_CLIENT_ID|PLAID_SECRET|PLAID_ENV|PLAID_REDIRECT_URI)\b|\bResend\b|not configured|server log|https?:\/\/[^/\s:@]+:[^/\s@]+@/i;

export type GoogleSignInDecision = {
  enabled: boolean;
};

export type VerificationMailPlan = {
  delivery: "send" | "local";
};

/**
 * Both values turn Google sign-in on. Neither hides it.
 * One of the two is a deployer mistake: the button stays hidden, and the
 * error names the missing setting for logs.
 */
export function resolveGoogleSignIn(input: {
  clientId: string;
  clientSecret: string;
}): Result<GoogleSignInDecision, ConfigError> {
  const clientId = input.clientId.trim();
  const clientSecret = input.clientSecret.trim();
  if (clientId && clientSecret) return ok({ enabled: true });
  if (!clientId && !clientSecret) return ok({ enabled: false });
  const missing = [clientId ? null : "GOOGLE_CLIENT_ID", clientSecret ? null : "GOOGLE_CLIENT_SECRET"].filter(
    (name): name is string => name !== null,
  );
  const verb = missing.length === 1 ? "is" : "are";
  return err(new ConfigError(`${missing.join(" and ")} ${verb} required for Google sign-in. Set both or leave both empty.`));
}

/**
 * Both values send mail. Neither, off a hosted deploy, records the link for
 * the person running the app. Anything else is a config error for logs.
 * Values of the settings are not copied into the error.
 */
export function planVerificationMail(input: {
  apiKey: string;
  from: string;
  hosted: boolean;
  label?: string;
}): Result<VerificationMailPlan, ConfigError> {
  const apiKey = input.apiKey.trim();
  const from = input.from.trim();
  if (apiKey && from) return ok({ delivery: "send" });
  if (!apiKey && !from && !input.hosted) return ok({ delivery: "local" });
  const missing = [apiKey ? null : "RESEND_API_KEY", from ? null : "RESEND_FROM"].filter(
    (name): name is string => name !== null,
  );
  const verb = missing.length === 1 ? "is" : "are";
  const where = input.hosted ? " on Vercel" : "";
  const label = input.label ?? "verification email";
  return err(new ConfigError(`${missing.join(" and ")} ${verb} required to send ${label}${where}.`));
}

export type MemberMailState = "send" | "local" | "unavailable";

/** Copy a member can read. Never names settings or how to configure a provider. */
export function verificationHelpForMember(state: MemberMailState): string {
  if (state === "send") return MEMBER_MAIL_READY;
  return MEMBER_MAIL_FAILURE;
}

export function hidesSetupDetail(error: unknown): boolean {
  if (error instanceof ConfigError || error instanceof MailDeliveryError || error instanceof TokenEncryptionError) {
    return true;
  }
  const message = error instanceof Error ? error.message : "";
  return SETUP_LEAK.test(message);
}

/**
 * Boundary mapping. Config and delivery errors keep their detail for logs;
 * this returns the sentence a member should see.
 */
export function memberFacingMessage(error: unknown, fallback = MEMBER_SETUP_FAILURE): string {
  if (hidesSetupDetail(error)) return fallback;
  if (error instanceof DomainError) return error.message;
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message.length > 0) return message;
  }
  return fallback;
}

export type MailDeliveryResult = Result<void, ConfigError | MailDeliveryError>;

export function acceptedMailDelivery(): MailDeliveryResult {
  return ok(undefined);
}

export function rejectedMailDelivery(error: ConfigError | MailDeliveryError): MailDeliveryResult {
  return err(error);
}
