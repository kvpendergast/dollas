import { Resend } from "resend";
import { logError, logInfo } from "@/lib/telemetry";

type Env = Record<string, string | undefined>;

export type VerificationMessage = {
  from: string;
  to: string;
  subject: string;
  text: string;
};

type MailKind = "verification" | "password reset";

const verificationSubject = "Verify your email for dollas";
const resetSubject = "Reset your dollas password";

function runningOnVercel(env: Env): boolean {
  return Boolean(env.VERCEL || env.VERCEL_ENV);
}

function fail(error: Error): never {
  logError(error);
  throw error;
}

function present(env: Env, name: string): string {
  return env[name]?.trim() ?? "";
}

export function verificationEmailHelp(env: Env = process.env): string {
  const apiKey = present(env, "RESEND_API_KEY");
  const from = present(env, "RESEND_FROM");
  if (apiKey && from) {
    return "Check your inbox for a verification message from dollas and open the link, then come back and sign in.";
  }
  if (!runningOnVercel(env)) {
    return "Resend is not configured, so the verification link is written to the server log. Open it, then come back and sign in.";
  }
  return "The verification email could not be sent because Resend is not configured on this server.";
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

function resetText(url: string): string {
  return [
    "Someone asked to choose a new password for this dollas login.",
    "",
    url,
    "",
    "The link expires in an hour and works once. If you did not ask, you can ignore this message.",
  ].join("\n");
}

function missingConfigError(env: Env, kind: MailKind): Error {
  const missing = ["RESEND_API_KEY", "RESEND_FROM"].filter((name) => !present(env, name));
  const verb = missing.length === 1 ? "is" : "are";
  const where = runningOnVercel(env) ? " on Vercel" : "";
  return new Error(`${missing.join(" and ")} ${verb} required to send ${kind} email${where}.`);
}

function containsSecret(detail: string, message: VerificationMessage, apiKey: string): boolean {
  if (apiKey && detail.includes(apiKey)) return true;
  if (detail.includes(message.text)) return true;
  return message.text.split("\n").some((line) => {
    const url = line.trim();
    return (url.startsWith("https://") || url.startsWith("http://")) && detail.includes(url);
  });
}

function resendFailure(providerMessage: string | undefined, message: VerificationMessage, apiKey: string, kind: MailKind): Error {
  const detail = providerMessage?.trim() ?? "";
  const suffix = detail && !containsSecret(detail, message, apiKey) ? `: ${detail}` : "";
  return new Error(`Resend could not send the ${kind} email${suffix}.`);
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
    if (error instanceof Error && error.message.startsWith(`Resend could not send the ${kind} email`)) throw error;
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
): Promise<void> {
  const env = options.env ?? process.env;
  const apiKey = present(env, "RESEND_API_KEY");
  const from = present(env, "RESEND_FROM");

  if (!apiKey || !from) {
    if (!apiKey && !from && !runningOnVercel(env)) {
      logInfo(copy.devLog, { email: input.email });
      console.info(copy.devLine);
      return;
    }
    fail(missingConfigError(env, kind));
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
    const failure = error instanceof Error ? error : new Error(`Resend could not send the ${kind} email.`);
    if (containsSecret(failure.message, message, apiKey)) fail(resendFailure(undefined, message, apiKey, kind));
    fail(failure);
  }
  logInfo(copy.sentLog, { email: input.email });
}

export async function deliverVerificationEmail(
  input: { email: string; url: string },
  options: {
    env?: Env;
    send?: (message: VerificationMessage, apiKey: string) => Promise<void>;
  } = {},
): Promise<void> {
  await deliverAuthEmail("verification", input, options, {
    subject: verificationSubject,
    text: verificationText(input.url),
    devLine: `Verify ${input.email}: ${input.url}`,
    devLog: "Verification link written to the dev log",
    sentLog: "Verification email sent",
  });
}

export async function deliverPasswordResetEmail(
  input: { email: string; url: string },
  options: {
    env?: Env;
    send?: (message: VerificationMessage, apiKey: string) => Promise<void>;
  } = {},
): Promise<void> {
  await deliverAuthEmail("password reset", input, options, {
    subject: resetSubject,
    text: resetText(input.url),
    devLine: `Reset password for ${input.email}: ${input.url}`,
    devLog: "Password reset link written to the dev log",
    sentLog: "Password reset email sent",
  });
}
