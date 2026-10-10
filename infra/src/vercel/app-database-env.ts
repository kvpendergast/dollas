import * as pulumi from "@pulumi/pulumi";
import * as vercel from "@pulumiverse/vercel";
import type { VercelTarget } from "../config";

export const APP_DATABASE_ENV_KEY = "DATABASE_URL_APP";

export type AppDatabaseEnvArgs = {
  projectId: string;
  teamId: string | undefined;
  targets: VercelTarget[];
  url: pulumi.Input<string>;
};

/**
 * DATABASE_URL_APP as a sensitive Vercel variable (write-only in the
 * dashboard). The app pool connects with it; migrations keep DATABASE_URL.
 * A changed value reaches the app on the next deployment.
 */
export function appDatabaseEnv(name: string, args: AppDatabaseEnvArgs, opts?: pulumi.CustomResourceOptions) {
  return new vercel.ProjectEnvironmentVariable(
    name,
    {
      projectId: args.projectId,
      teamId: args.teamId,
      key: APP_DATABASE_ENV_KEY,
      value: pulumi.secret(args.url),
      targets: args.targets,
      sensitive: true,
      comment: "dollas_app login for the app pool (row-level security). Managed by Pulumi in infra/ (PEN-214).",
    },
    opts,
  );
}
