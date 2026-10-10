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
 * Kept (adopted) variables must never be updated: an update sends the value in
 * state, which is empty for a sensitive variable, and would wipe the secret.
 * So every mutable field is ignored. The provider requires exactly one of value
 * or value_wo: a kept plain variable imports its value, and a kept sensitive one
 * (whose value Vercel never returns) gets this write-only placeholder instead.
 * With nothing to update, the placeholder is never sent.
 */
export const KEPT_IGNORE = ["value", "comment", "targets", "sensitive", "gitBranch", "customEnvironmentIds"];
const KEPT_PLACEHOLDER = "unused: Vercel keeps the existing value";

/**
 * One Vercel variable per plan instance. Adopted instances are imported by id,
 * keep Vercel's value and settings, and are protected when dollas:protect is on.
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
    const kept = plan.source.kind === "keep";
    if (kept !== (value === undefined)) throw new Error(`${plan.key}: only adopted variables may have no value.`);
    const opts = optsFor(plan);
    const split = plan.instances.length > 1;
    for (const instance of plan.instances) {
      const adopted = instance.importId !== undefined;
      const sensitive = instance.sensitive ?? plan.sensitive;
      created.push(
        new vercel.ProjectEnvironmentVariable(
          envResourceName(plan.key, instance.targets, split),
          {
            projectId,
            teamId: settings.project.teamId,
            key: plan.key,
            value: kept ? undefined : pulumi.secret(value as pulumi.Input<string>),
            valueWo: kept && sensitive ? pulumi.secret(KEPT_PLACEHOLDER) : undefined,
            targets: instance.targets,
            sensitive,
            comment: adopted ? undefined : (COMMENTS[plan.key] ?? "Managed by Pulumi in infra/."),
          },
          {
            ...opts,
            import: adopted ? importId(settings.project.teamId, settings.project.existingId ?? "", instance.importId ?? "") : undefined,
            ignoreChanges: kept ? KEPT_IGNORE : undefined,
            protect: settings.protect && adopted ? true : opts.protect,
          },
        ),
      );
    }
  }
  return created;
}
