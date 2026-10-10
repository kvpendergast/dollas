import * as pulumi from "@pulumi/pulumi";
import * as vercel from "@pulumiverse/vercel";
import { envResourceName, type EnvKey, type EnvPlan, type Settings } from "../settings";
import { importId } from "./project";

export const APP_DATABASE_ENV_KEY = "DATABASE_URL_APP";

const COMMENTS: Partial<Record<EnvKey, string>> = {
  // Same text as PEN-214 so an existing stack shows no change.
  DATABASE_URL_APP: "dollas_app login for the app pool (row-level security). Managed by Pulumi in infra/ (PEN-214).",
  DATABASE_URL: "Postgres owner, pooled. Migrations only. Managed by Pulumi in infra/.",
  DATABASE_URL_UNPOOLED: "Postgres owner, direct. Startup migrations. Managed by Pulumi in infra/.",
};

/**
 * One Vercel variable per plan instance. Adopted instances are imported by id,
 * keep Vercel's value and comment, and are protected when dollas:protect is on.
 */
export function dollasEnv(
  settings: Settings<unknown>,
  projectId: pulumi.Input<string>,
  valueOf: (plan: EnvPlan<unknown>) => pulumi.Input<string> | undefined,
  optsFor: (plan: EnvPlan<unknown>) => pulumi.CustomResourceOptions = () => ({}),
): vercel.ProjectEnvironmentVariable[] {
  const created: vercel.ProjectEnvironmentVariable[] = [];
  for (const plan of settings.env) {
    const value = valueOf(plan);
    const opts = optsFor(plan);
    const split = plan.instances.length > 1;
    for (const instance of plan.instances) {
      const adopted = instance.importId !== undefined;
      created.push(
        new vercel.ProjectEnvironmentVariable(
          envResourceName(plan.key, instance.targets, split),
          {
            projectId,
            teamId: settings.project.teamId,
            key: plan.key,
            value: value === undefined ? undefined : plan.sensitive ? pulumi.secret(value) : value,
            targets: instance.targets,
            sensitive: plan.sensitive,
            comment: adopted ? undefined : (COMMENTS[plan.key] ?? "Managed by Pulumi in infra/."),
          },
          {
            ...opts,
            import: adopted ? importId(settings.project.teamId, settings.project.existingId ?? "", instance.importId ?? "") : undefined,
            ignoreChanges: adopted ? ["value", "comment"] : undefined,
            protect: settings.protect && adopted ? true : opts.protect,
          },
        ),
      );
    }
  }
  return created;
}
