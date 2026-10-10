/**
 * Read-only: lists an existing Vercel project's environment variables (keys,
 * ids, targets, type; never values) and prints the dollas:adoptEnv config.
 *
 *   VERCEL_API_TOKEN=... pnpm --filter @dollas/infra adopt-env -- --project prj_... [--team team_...]
 */
import { adoptReport, type VercelEnvListing } from "../src/adopt";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const token = process.env.VERCEL_API_TOKEN ?? process.env.VERCEL_TOKEN;
  const project = arg("project");
  const team = arg("team");
  if (!token || !project) {
    console.error("Usage: VERCEL_API_TOKEN=... pnpm --filter @dollas/infra adopt-env -- --project prj_... [--team team_...]");
    process.exit(2);
  }
  const envs: VercelEnvListing[] = [];
  let until: string | undefined;
  do {
    // DOLLAS_VERCEL_API is for tests against a local mock only.
    const base = process.env.DOLLAS_VERCEL_API ?? "https://api.vercel.com";
    const url = new URL(`${base}/v10/projects/${encodeURIComponent(project)}/env`);
    if (team) url.searchParams.set("teamId", team);
    url.searchParams.set("limit", "100");
    if (until) url.searchParams.set("until", until);
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Vercel API ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const page = (await response.json()) as { envs: VercelEnvListing[]; pagination?: { next?: number | null } };
    envs.push(...page.envs.map(({ id, key, type, target, gitBranch, customEnvironmentIds, configurationId }) => ({ id, key, type, target, gitBranch, customEnvironmentIds, configurationId })));
    until = page.pagination?.next ? String(page.pagination.next) : undefined;
  } while (until);

  const report = adoptReport(envs);
  console.log(`# ${envs.length} variables on ${project}. Run in infra/ with the stack selected:`);
  console.log(`pulumi config set dollas:databaseEnv ${report.databaseEnv}`);
  for (const command of report.commands) console.log(command);
  for (const note of report.notes) console.log(`# note: ${note}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
