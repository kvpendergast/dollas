import { Resend } from "resend";
import { logError, logInfo } from "@/lib/telemetry";

type Env = Record<string, string | undefined>;

export type VerificationMessage = {
  from: string;
  to: string;
  subject: string;
  text: string;
};

const subject = "Verify your email for dollas";

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

function missingConfigError(env: Env): Error {
  const missing = ["RESEND_API_KEY", "RESEND_FROM"].filter((name) => !present(env, name));
  const verb = missing.length === 1 ? "is" : "are";
  const where = runningOnVercel(env) ? " on Vercel" : "";
  return new Error(`${missing.join(" and ")} ${verb} required to send verification email${where}.`);
}

function containsSecret(detail: string, message: VerificationMessage, apiKey: string): boolean {
  if (apiKey && detail.includes(apiKey)) return true;
  if (detail.includes(message.text)) return true;
  return message.text.split("\n").some((line) => {
    const url = line.trim();
    return (url.startsWith("https://") || url.startsWith("http://")) && detail.includes(url);
  });
}

function resendFailure(providerMessage: string | undefined, message: VerificationMessage, apiKey: string): Error {
  const detail = providerMessage?.trim() ?? "";
  const suffix = detail && !containsSecret(detail, message, apiKey) ? `: ${detail}` : "";
  return new Error(`Resend could not send the verification email${suffix}.`);
}

async function sendWithResend(message: VerificationMessage, apiKey: string): Promise<void> {
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
      throw resendFailure(providerMessage, message, apiKey);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Resend could not send the verification email")) throw error;
    const providerMessage = error instanceof Error ? error.message : undefined;
    throw resendFailure(providerMessage, message, apiKey);
  }
}

export async function deliverVerificationEmail(
  input: { email: string; url: string },
  options: {
    env?: Env;
    send?: (message: VerificationMessage, apiKey: string) => Promise<void>;
  } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const apiKey = present(env, "RESEND_API_KEY");
  const from = present(env, "RESEND_FROM");

  if (!apiKey || !from) {
    if (!apiKey && !from && !runningOnVercel(env)) {
      logInfo("Email verification link", { email: input.email, url: input.url });
      console.info(`Verify ${input.email}: ${input.url}`);
      return;
    }
    fail(missingConfigError(env));
  }

  const message: VerificationMessage = {
    from,
    to: input.email,
    subject,
    text: verificationText(input.url),
  };
  try {
    await (options.send ?? sendWithResend)(message, apiKey);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error("Resend could not send the verification email.");
    if (containsSecret(failure.message, message, apiKey)) fail(resendFailure(undefined, message, apiKey));
    fail(failure);
  }
  logInfo("Verification email sent", { email: input.email });
}
