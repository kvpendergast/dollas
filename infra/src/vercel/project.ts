import * as pulumi from "@pulumi/pulumi";
import * as vercel from "@pulumiverse/vercel";
import type { Settings } from "../settings";

/**
 * Settings the provider fills with its own defaults. On an adopted project they
 * keep whatever the project already has instead of being reset.
 */
const ADOPT_IGNORE = ["autoAssignCustomDomains", "gitForkProtection", "oidcTokenConfig"];

export function importId(teamId: string | undefined, ...parts: string[]): string {
  return [teamId, ...parts].filter(Boolean).join("/");
}

/** The Vercel project: created, or adopted when dollas:vercelProjectId is set. */
export function dollasProject(settings: Settings<unknown>): vercel.Project {
  const { project } = settings;
  const adopting = Boolean(project.existingId);
  const ignoreChanges = adopting
    ? [
        ...ADOPT_IGNORE,
        ...(project.installCommand ? [] : ["installCommand"]),
        ...(project.buildCommand ? [] : ["buildCommand"]),
        ...(project.gitRepository ? [] : ["gitRepository"]),
      ]
    : [];
  return new vercel.Project(
    "dollas-project",
    {
      name: project.name,
      teamId: project.teamId,
      framework: project.framework,
      rootDirectory: project.rootDirectory,
      nodeVersion: project.nodeVersion,
      installCommand: project.installCommand,
      buildCommand: project.buildCommand,
      gitRepository: project.gitRepository,
    },
    {
      import: project.existingId ? importId(project.teamId, project.existingId) : undefined,
      protect: settings.protect,
      ignoreChanges,
    },
  );
}

/** Optional custom domain. Point DNS at Vercel as its dashboard says. */
export function dollasDomain(settings: Settings<unknown>, projectId: pulumi.Input<string>): vercel.ProjectDomain | undefined {
  if (!settings.domain) return undefined;
  return new vercel.ProjectDomain(
    "dollas-domain",
    { projectId, teamId: settings.project.teamId, domain: settings.domain },
    {
      import:
        settings.adoptDomain && settings.project.existingId
          ? importId(settings.project.teamId, settings.project.existingId, settings.domain)
          : undefined,
      protect: settings.protect,
    },
  );
}
