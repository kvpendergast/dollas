import {
  acceptedMailDelivery,
  MailDeliveryError,
  planVerificationMail,
  rejectedMailDelivery,
  verificationHelpForMember,
  MEMBER_RESET_MAIL_FAILURE,
  type MailDeliveryResult,
} from "@dollas/domain";
import { Resend } from "resend";
import { logError, logInfo } from "@/lib/telemetry";

type Env = Record<string, string | undefined>;

export type VerificationMessage = {
  from: string;
  to: string;
  subject: string;
  text: string;
};

type MailKind = "verification" | "password reset" | "household invite";

const verificationSubject = "Verify your email for dollas";
const resetSubject = "Reset your dollas password";
const emailChangeSubject = "Confirm your new email for dollas";

function runningOnVercel(env: Env): boolean {
  return Boolean(env.VERCEL || env.VERCEL_ENV);
}

function present(env: Env, name: string): string {
  return env[name]?.trim() ?? "";
}

function mailPlan(env: Env, label: string) {
  return planVerificationMail({
    apiKey: present(env, "RESEND_API_KEY"),
    from: present(env, "RESEND_FROM"),
    hosted: runningOnVercel(env),
    label,
  });
}

export function verificationEmailHelp(env: Env = process.env): string {
  const plan = mailPlan(env, "verification email");
  if (plan.isErr()) return verificationHelpForMember("unavailable");
  return verificationHelpForMember(plan.value.delivery);
}

/** Shown on the forgot-password page. Empty when mail can be sent. */
export function passwordResetEmailHelp(env: Env = process.env): string {
  const plan = mailPlan(env, "password reset email");
  if (plan.isOk() && plan.value.delivery === "send") return "";
  return MEMBER_RESET_MAIL_FAILURE;
}

function verificationText(url: string): string {
  return [
    "Verify your email to finish signing up for dollas.",
    "",
    url,
    "",
    "If you did not create an account, you can ignore this message.",
  ].join("\n");
}

function emailChangeText(url: string): string {
  return [
    "Confirm this email for your dollas login.",
    "",
    url,
    "",
    "Your previous email stays the one you sign in with until you open this link.",
    "If you did not ask to change it, you can ignore this message.",
  ].join("\n");
}

function resetText(url: string): string {
  return [
    "Someone asked to choose a new password for this dollas login.",
    "",
    url,
    "",
    "The link expires in an hour and works once. If you did not ask, you can ignore this message.",
  ].join("\n");
}

function containsSecret(detail: string, message: VerificationMessage, apiKey: string): boolean {
  if (apiKey && detail.includes(apiKey)) return true;
  if (detail.includes(message.text)) return true;
  return message.text.split("\n").some((line) => {
    const url = line.trim();
    return (url.startsWith("https://") || url.startsWith("http://")) && detail.includes(url);
  });
}

function resendFailure(
  providerMessage: string | undefined,
  message: VerificationMessage,
  apiKey: string,
  kind: MailKind,
): MailDeliveryError {
  const detail = providerMessage?.trim() ?? "";
  const suffix = detail && !containsSecret(detail, message, apiKey) ? `: ${detail}` : "";
  return new MailDeliveryError(`Resend could not send the ${kind} email${suffix}.`);
}

async function sendWithResend(message: VerificationMessage, apiKey: string, kind: MailKind): Promise<void> {
  try {
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send({
      from: message.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    if (error || !data) {
      const providerMessage = error && typeof error.message === "string" ? error.message : undefined;
      throw resendFailure(providerMessage, message, apiKey, kind);
    }
  } catch (error) {
    if (error instanceof MailDeliveryError) throw error;
    const providerMessage = error instanceof Error ? error.message : undefined;
    throw resendFailure(providerMessage, message, apiKey, kind);
  }
}

async function deliverAuthEmail(
  kind: MailKind,
  input: { email: string; url: string },
  options: {
    env?: Env;
    send?: (message: VerificationMessage, apiKey: string) => Promise<void>;
  },
  copy: { subject: string; text: string; devLine: string; devLog: string; sentLog: string },
): Promise<MailDeliveryResult> {
  const env = options.env ?? process.env;
  const apiKey = present(env, "RESEND_API_KEY");
  const from = present(env, "RESEND_FROM");
  const label = `${kind} email`;
  const action = `${kind.replace(/ /g, "-")}-email`;
  const plan = mailPlan(env, label);

  if (plan.isErr()) {
    logError(plan.error, { action });
    return rejectedMailDelivery(plan.error);
  }

  if (plan.value.delivery === "local") {
    logInfo(copy.devLog, { email: input.email });
    console.info(copy.devLine);
    return acceptedMailDelivery();
  }

  const message: VerificationMessage = {
    from,
    to: input.email,
    subject: copy.subject,
    text: copy.text,
  };
  try {
    await (options.send ?? ((outgoing, key) => sendWithResend(outgoing, key, kind)))(message, apiKey);
  } catch (error) {
    const failure = error instanceof MailDeliveryError ? error : resendFailure(undefined, message, apiKey, kind);
    const safe = containsSecret(failure.message, message, apiKey) ? resendFailure(undefined, message, apiKey, kind) : failure;
    logError(safe, { action });
    return rejectedMailDelivery(safe);
  }
  logInfo(copy.sentLog, { email: input.email });
  return acceptedMailDelivery();
}

export async function deliverVerificationEmail(
  input: { email: string; url: string },
  options: {
    env?: Env;
    send?: (message: VerificationMessage, apiKey: string) => Promise<void>;
  } = {},
): Promise<MailDeliveryResult> {
  return deliverAuthEmail("verification", input, options, {
    subject: verificationSubject,
    text: verificationText(input.url),
    devLine: `Verify ${input.email}: ${input.url}`,
    devLog: "Verification link written to the dev log",
    sentLog: "Verification email sent",
  });
}

export async function deliverEmailChangeEmail(
  input: { email: string; url: string },
  options: {
    env?: Env;
    send?: (message: VerificationMessage, apiKey: string) => Promise<void>;
  } = {},
): Promise<MailDeliveryResult> {
  return deliverAuthEmail("verification", input, options, {
    subject: emailChangeSubject,
    text: emailChangeText(input.url),
    devLine: `Confirm new email ${input.email}: ${input.url}`,
    devLog: "Email change link written to the dev log",
    sentLog: "Email change verification sent",
  });
}

export async function deliverPasswordResetEmail(
  input: { email: string; url: string },
  options: {
    env?: Env;
    send?: (message: VerificationMessage, apiKey: string) => Promise<void>;
  } = {},
): Promise<MailDeliveryResult> {
  return deliverAuthEmail("password reset", input, options, {
    subject: resetSubject,
    text: resetText(input.url),
    devLine: `Reset password for ${input.email}: ${input.url}`,
    devLog: "Password reset link written to the dev log",
    sentLog: "Password reset email sent",
  });
}

export type InviteMailMode = "send" | "local" | "unavailable";

/**
 * How an invite email would go out. "local" writes the link to the dev log.
 * "unavailable" means a hosted deploy without Resend; the owner copies the link.
 */
export function inviteMailMode(env: Env = process.env): InviteMailMode {
  const plan = mailPlan(env, "household invite email");
  if (plan.isErr()) return "unavailable";
  return plan.value.delivery === "send" ? "send" : "local";
}

function inviteText(input: { url: string; householdName: string; inviterName: string; expiresOn: string }): string {
  return [
    `${input.inviterName} invited you to keep the ${input.householdName} books together in dollas.`,
    "",
    "Open this link, then sign in or create a login with this email address:",
    "",
    input.url,
    "",
    `You get your own login and see the same accounts, transactions, categories, and budget. The link works once and expires on ${input.expiresOn}.`,
    "If you were not expecting this, you can ignore this message.",
  ].join("\n");
}

export async function deliverHouseholdInviteEmail(
  input: { email: string; url: string; householdName: string; inviterName: string; expiresOn: string },
  options: {
    env?: Env;
    send?: (message: VerificationMessage, apiKey: string) => Promise<void>;
  } = {},
): Promise<MailDeliveryResult> {
  return deliverAuthEmail("household invite", input, options, {
    subject: `${input.inviterName} invited you to the ${input.householdName} books`,
    text: inviteText(input),
    devLine: `Invite for ${input.email}: ${input.url}`,
    devLog: "Household invite link written to the dev log",
    sentLog: "Household invite email sent",
  });
}
