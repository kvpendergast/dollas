import { ENV_KEYS, SENSITIVE, VERCEL_TARGETS, type EnvKey, type VercelTarget } from "./settings";

/** The fields of a Vercel environment variable listing this needs. Values are never read. */
export type VercelEnvListing = {
  id: string;
  key: string;
  type: string;
  target?: string[] | string;
  gitBranch?: string | null;
  customEnvironmentIds?: string[];
  configurationId?: string | null;
};

export type AdoptReport = {
  /** `pulumi config set --path` commands for dollas:adoptEnv. */
  commands: string[];
  databaseEnv: "integration" | "pulumi";
  notes: string[];
};

const MANAGED = new Set<string>(ENV_KEYS.filter((key) => key !== "DATABASE_URL_APP"));

/**
 * Turns an existing project's variable listing into dollas:adoptEnv config.
 * Integration-owned DATABASE_URL* are left to the integration.
 */
export function adoptReport(envs: VercelEnvListing[]): AdoptReport {
  const notes: string[] = [];
  const integration = envs.some((env) => env.key === "DATABASE_URL" && env.configurationId);
  const entries = new Map<EnvKey, Array<{ id: string; targets: VercelTarget[]; sensitive: boolean }>>();

  for (const env of envs) {
    if (env.key === "DATABASE_URL_APP") {
      notes.push(`DATABASE_URL_APP (${env.id}) already exists. If Pulumi did not create it, delete it in Vercel before pulumi up; Pulumi owns its password.`);
      continue;
    }
    if (!MANAGED.has(env.key)) continue;
    if (env.configurationId) {
      if (env.key.startsWith("DATABASE_URL")) continue;
      notes.push(`${env.key} (${env.id}) is owned by an integration; leaving it out.`);
      continue;
    }
    const targets = (Array.isArray(env.target) ? env.target : env.target ? [env.target] : []).filter(
      (target): target is VercelTarget => (VERCEL_TARGETS as readonly string[]).includes(target),
    );
    const skipped = (Array.isArray(env.target) ? env.target : [env.target]).filter((target) => target && !targets.includes(target as VercelTarget));
    if (env.gitBranch || (env.customEnvironmentIds?.length ?? 0) > 0) {
      notes.push(`${env.key} (${env.id}) is scoped to a git branch or custom environment; the recipe leaves it alone.`);
      continue;
    }
    if (targets.length === 0) {
      notes.push(`${env.key} (${env.id}) only targets ${skipped.join(",") || "nothing"}; the recipe leaves it alone.`);
      continue;
    }
    if (skipped.length > 0) {
      notes.push(`${env.key} (${env.id}) also targets ${skipped.join(",")}; adopting it would remove that target. Split it in Vercel first, or leave it unmanaged by removing it from adoptEnv.`);
    }
    const list = entries.get(env.key as EnvKey) ?? [];
    list.push({ id: env.id, targets, sensitive: env.type === "sensitive" });
    entries.set(env.key as EnvKey, list);
  }

  const commands: string[] = [];
  for (const key of ENV_KEYS) {
    const list = entries.get(key);
    if (!list) continue;
    if (key.startsWith("DATABASE_URL") && integration) continue;
    list.forEach((entry, index) => {
      const at = `dollas:adoptEnv.${key}[${index}]`;
      commands.push(`pulumi config set --plaintext --path '${at}.id' ${entry.id}`);
      entry.targets.forEach((target, t) => commands.push(`pulumi config set --plaintext --path '${at}.targets[${t}]' ${target}`));
      if (entry.sensitive !== SENSITIVE[key]) commands.push(`pulumi config set --plaintext --path '${at}.sensitive' ${entry.sensitive}`);
    });
  }
  if (commands.length === 0) commands.push("pulumi config set --path 'dollas:adoptEnv' '{}'");
  return { commands, databaseEnv: integration ? "integration" : "pulumi", notes };
}
