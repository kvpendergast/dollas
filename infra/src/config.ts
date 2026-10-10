import * as pulumi from "@pulumi/pulumi";

/** Vercel sensitive variables cannot target development. */
export const VERCEL_TARGETS = ["production", "preview"] as const;
export type VercelTarget = (typeof VERCEL_TARGETS)[number];

export type StackSettings = {
  /** Neon owner, direct (unpooled) URL. Pulumi uses it only to run the role SQL. */
  ownerDatabaseUrl: pulumi.Output<string>;
  /** Host for DATABASE_URL_APP. Defaults to the pooled form of the owner host. */
  appDatabaseHost: string | undefined;
  /** Bump to rotate the dollas_app password. */
  appPasswordVersion: string;
  vercelProjectId: string;
  vercelTeamId: string | undefined;
  vercelTargets: VercelTarget[];
};

export function parseTargets(raw: string | undefined): VercelTarget[] {
  if (!raw) return ["production", "preview"];
  const targets = raw.split(",").map((value) => value.trim()).filter(Boolean);
  for (const target of targets) {
    if (!(VERCEL_TARGETS as readonly string[]).includes(target)) {
      throw new Error(`dollas:vercelTargets has "${target}"; use production or preview (sensitive variables cannot target development).`);
    }
  }
  if (targets.length === 0) throw new Error("dollas:vercelTargets is empty.");
  return targets as VercelTarget[];
}

export function readStackSettings(config = new pulumi.Config("dollas")): StackSettings {
  return {
    ownerDatabaseUrl: config.requireSecret("ownerDatabaseUrl"),
    appDatabaseHost: config.get("appDatabaseHost"),
    appPasswordVersion: config.get("appPasswordVersion") ?? "1",
    vercelProjectId: config.require("vercelProjectId"),
    vercelTeamId: config.get("vercelTeamId"),
    vercelTargets: parseTargets(config.get("vercelTargets")),
  };
}
