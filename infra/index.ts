/**
 * Dollas deploy infrastructure.
 *
 * PEN-214: the dollas_app LOGIN role and DATABASE_URL_APP on Vercel.
 * PEN-211 adds the rest of the Vercel recipe here as more modules under src/.
 */
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { readStackSettings } from "./src/config";
import { AppLogin } from "./src/database/app-login";
import { APP_PASSWORD_LENGTH, appDatabaseUrl as buildAppDatabaseUrl } from "./src/database/app-login-sql";
import { APP_DATABASE_ENV_KEY, appDatabaseEnv } from "./src/vercel/app-database-env";

const settings = readStackSettings();

const appPassword = new random.RandomPassword("dollas-app-password", {
  length: APP_PASSWORD_LENGTH,
  special: false,
  minLower: 4,
  minUpper: 4,
  minNumeric: 4,
  keepers: { version: settings.appPasswordVersion },
});

const appLogin = new AppLogin("dollas-app-login", {
  ownerDatabaseUrl: settings.ownerDatabaseUrl,
  password: appPassword.result,
});

const appUrl = pulumi
  .all([settings.ownerDatabaseUrl, appPassword.result])
  .apply(([owner, password]) => buildAppDatabaseUrl(owner, password, settings.appDatabaseHost));

const env = appDatabaseEnv(
  "database-url-app",
  {
    projectId: settings.vercelProjectId,
    teamId: settings.vercelTeamId,
    targets: settings.vercelTargets,
    url: appUrl,
  },
  { dependsOn: [appLogin] },
);

export const appRole = appLogin.role;
export const appPasswordVersion = settings.appPasswordVersion;
export const vercelEnvKey = APP_DATABASE_ENV_KEY;
export const vercelEnvTargets = env.targets;
/** Secret. For the verify step: `pulumi stack output appDatabaseUrl --show-secrets`. */
export const appDatabaseUrl = pulumi.secret(appUrl);
