/**
 * Dollas on Vercel: the Pulumi recipe (PEN-211).
 *
 * - The Vercel project (Next.js in apps/web of the pnpm workspace), created or adopted.
 * - Every environment variable the app reads, from stack config. Secrets stay in
 *   Pulumi config (encrypted) or, for adopted variables, in Vercel.
 * - The dollas_app LOGIN role and DATABASE_URL_APP (PEN-214).
 * - An optional custom domain.
 *
 * Migrations are not run here: the app applies them at boot with the owner URL
 * (DATABASE_URL_UNPOOLED) under an advisory lock. See infra/README.md.
 */
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { readSettings } from "./src/config";
import { AppLogin } from "./src/database/app-login";
import { APP_PASSWORD_LENGTH, appDatabaseUrl as buildAppDatabaseUrl, pooledHost } from "./src/database/app-login-sql";
import {
  bankKeyRing,
  checkBankConnectionKeys,
  checkBetterAuthSecret,
  checkNotBlank,
  checkPostgresUrl,
  type EnvPlan,
} from "./src/settings";
import { APP_DATABASE_ENV_KEY, dollasEnv } from "./src/vercel/env";
import { dollasDomain, dollasProject } from "./src/vercel/project";

const settings = readSettings();
const ownerUrl = settings.database.ownerUrl.apply((url) => checkPostgresUrl("dollas:ownerDatabaseUrl", url));

// PEN-214: the dollas_app login. Resource names are unchanged so existing stacks see no diff.
const appPassword = new random.RandomPassword("dollas-app-password", {
  length: APP_PASSWORD_LENGTH,
  special: false,
  minLower: 4,
  minUpper: 4,
  minNumeric: 4,
  keepers: { version: settings.database.appPasswordVersion },
});
const appLogin = new AppLogin("dollas-app-login", { ownerDatabaseUrl: ownerUrl, password: appPassword.result });
const appUrl = pulumi
  .all([ownerUrl, appPassword.result])
  .apply(([owner, password]) => buildAppDatabaseUrl(owner, password, settings.database.appHost));

// Owner URL for DATABASE_URL: the given pooled URL, or Neon's pooled host for the owner.
const pooledOwnerUrl = (settings.database.pooledUrl ?? ownerUrl).apply((url) => {
  checkPostgresUrl("dollas:ownerPooledDatabaseUrl", url);
  if (settings.database.pooledUrl) return url;
  const parsed = new URL(url);
  parsed.hostname = pooledHost(parsed.hostname);
  return parsed.toString();
});

const project = dollasProject(settings);
// An adopted project's id is known before the import resolves, so env vars diff cleanly.
const projectId: pulumi.Input<string> = settings.project.existingId ?? project.id;
const domain = dollasDomain(settings, projectId);

const generated: { betterAuthSecret?: random.RandomPassword; bankKey?: random.RandomBytes } = {};
function generatedValue(generator: "betterAuthSecret" | "bankConnectionKeys"): pulumi.Output<string> {
  if (generator === "betterAuthSecret") {
    generated.betterAuthSecret ??= new random.RandomPassword("better-auth-secret", { length: 64, special: false });
    return generated.betterAuthSecret.result;
  }
  generated.bankKey ??= new random.RandomBytes("bank-connection-key-v1", { length: 32 });
  return generated.bankKey.base64.apply(bankKeyRing);
}

const CHECKS: Partial<Record<string, (value: string) => string>> = {
  BETTER_AUTH_SECRET: checkBetterAuthSecret,
  BANK_CONNECTION_KEYS: checkBankConnectionKeys,
};

function valueOf(plan: EnvPlan<unknown>): pulumi.Input<string> | undefined {
  const source = plan.source;
  switch (source.kind) {
    case "keep":
      return undefined;
    case "plain":
      return source.value;
    case "secret": {
      const check = CHECKS[plan.key] ?? ((value: string) => checkNotBlank(plan.key, value));
      return (source.value as pulumi.Output<string>).apply(check);
    }
    case "generated":
      return generatedValue(source.generator);
    case "database":
      return source.which === "app" ? appUrl : source.which === "direct" ? ownerUrl : pooledOwnerUrl;
  }
}

// DATABASE_URL_APP must not reach Vercel before the role accepts its password.
dollasEnv(settings, projectId, valueOf, (plan) => (plan.key === APP_DATABASE_ENV_KEY ? { dependsOn: [appLogin] } : {}));

export const vercelProjectId = projectId;
export const vercelProjectName = project.name;
export const customDomain = domain?.domain;
export const appRole = appLogin.role;
export const appPasswordVersion = settings.database.appPasswordVersion;
export const managedEnv = settings.env.map((plan) => ({
  key: plan.key,
  source: plan.source.kind,
  targets: plan.instances.map((instance) => instance.targets.join(",")),
}));
/** Secret. For the verify step: `pulumi stack output appDatabaseUrl --show-secrets`. */
export const appDatabaseUrl = pulumi.secret(appUrl);
/** Secret, only when generated. Keep it when rotating: old tokens decrypt with it. */
export const bankConnectionKeys = generated.bankKey ? pulumi.secret(generatedValue("bankConnectionKeys")) : undefined;
