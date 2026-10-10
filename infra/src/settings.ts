/**
 * Stack settings for the Dollas Vercel recipe, parsed and validated without
 * Pulumi so the rules are unit tested. Secret values are opaque here (`S` is a
 * string in tests and a pulumi.Output in the program); only whether they are
 * set matters for planning. Their contents are checked by the validators at
 * the bottom, which the program applies inside `apply`.
 */

/** Vercel sensitive variables cannot target development. */
export const VERCEL_TARGETS = ["production", "preview"] as const;
export type VercelTarget = (typeof VERCEL_TARGETS)[number];

export const SECRET_KEYS = [
  "ownerDatabaseUrl",
  "ownerPooledDatabaseUrl",
  "betterAuthSecret",
  "bankConnectionKeys",
  "resendApiKey",
  "googleClientId",
  "googleClientSecret",
  "plaidClientId",
  "plaidSecret",
] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

export const PLAIN_KEYS = [
  "vercelTeamId",
  "vercelProjectId",
  "projectName",
  "gitRepository",
  "productionBranch",
  "nodeVersion",
  "domain",
  "betterAuthUrl",
  "resendFrom",
  "plaidEnv",
  "plaidRedirectUri",
  "databaseEnv",
  "appDatabaseHost",
  "appPasswordVersion",
  "vercelTargets",
  "protect",
  "adoptDomain",
  "installCommand",
  "buildCommand",
] as const;
export type PlainKey = (typeof PLAIN_KEYS)[number];

export type SettingsSource<S> = {
  plain(key: PlainKey): string | undefined;
  secret(key: SecretKey): S | undefined;
  /** dollas:adoptEnv, already parsed from YAML/JSON. */
  adoptEnv(): unknown;
};

export type AdoptedEnv = { id: string; targets: VercelTarget[] };

/** Where an environment variable's value comes from. */
export type EnvSource<S> =
  | { kind: "secret"; value: S }
  | { kind: "plain"; value: string }
  | { kind: "generated"; generator: "betterAuthSecret" | "bankConnectionKeys" }
  | { kind: "database"; which: "pooled" | "direct" | "app" }
  /** Adopted from an existing project with no value in config: Vercel keeps its value. */
  | { kind: "keep" };

export type EnvPlan<S> = {
  key: EnvKey;
  sensitive: boolean;
  source: EnvSource<S>;
  /** One Vercel variable per entry. Adopted keys follow the existing layout. */
  instances: Array<{ targets: VercelTarget[]; importId?: string }>;
};

export type Settings<S> = {
  project: {
    name: string;
    teamId: string | undefined;
    /** Set when adopting an existing Vercel project instead of creating one. */
    existingId: string | undefined;
    framework: "nextjs";
    /** The Next.js app in the pnpm workspace. apps/web/vercel.json sets the install command. */
    rootDirectory: "apps/web";
    /** Unset by default: apps/web/vercel.json and the Next.js preset decide. */
    installCommand: string | undefined;
    buildCommand: string | undefined;
    nodeVersion: string;
    gitRepository: { type: "github"; repo: string; productionBranch: string } | undefined;
  };
  domain: string | undefined;
  /** The domain is already on the existing project; import it instead of adding it. */
  adoptDomain: boolean;
  targets: VercelTarget[];
  protect: boolean;
  database: {
    env: "pulumi" | "integration";
    ownerUrl: S;
    pooledUrl: S | undefined;
    appHost: string | undefined;
    appPasswordVersion: string;
  };
  env: EnvPlan<S>[];
};

/** apps/web/vercel.json sets this, so the project resource leaves it unset. */
export const INSTALL_COMMAND = "pnpm install --frozen-lockfile --filter @dollas/web...";

/** Every variable the app reads that this recipe can manage. */
export const ENV_KEYS = [
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "DATABASE_URL_APP",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_SECRET",
  "BANK_CONNECTION_KEYS",
  "RESEND_API_KEY",
  "RESEND_FROM",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "PLAID_CLIENT_ID",
  "PLAID_SECRET",
  "PLAID_ENV",
  "PLAID_REDIRECT_URI",
] as const;
export type EnvKey = (typeof ENV_KEYS)[number];

export class SettingsError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Fix the dollas stack config:\n- ${problems.join("\n- ")}`);
    this.name = "SettingsError";
  }
}

const PROJECT_NAME = /^[a-z0-9]([a-z0-9._-]{0,98}[a-z0-9])?$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NODE_VERSION = /^\d{2}\.x$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function parseTargets(raw: string | undefined): VercelTarget[] {
  if (!raw) return ["production", "preview"];
  const targets = raw.split(",").map((value) => value.trim()).filter(Boolean);
  for (const target of targets) {
    if (!(VERCEL_TARGETS as readonly string[]).includes(target)) {
      throw new SettingsError([`dollas:vercelTargets has "${target}"; use production or preview (sensitive variables cannot target development).`]);
    }
  }
  if (targets.length === 0) throw new SettingsError(["dollas:vercelTargets is empty."]);
  return [...new Set(targets)] as VercelTarget[];
}

function parseBool(raw: string | undefined, key: string, fallback: boolean, problems: string[]): boolean {
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  problems.push(`dollas:${key} must be true or false.`);
  return fallback;
}

/** dollas:adoptEnv → { KEY: [{ id, targets }] }, checked for shape and overlap. */
export function parseAdoptEnv(raw: unknown, problems: string[]): Partial<Record<EnvKey, AdoptedEnv[]>> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    problems.push("dollas:adoptEnv must be a map of variable name to a list of { id, targets }.");
    return {};
  }
  const result: Partial<Record<EnvKey, AdoptedEnv[]>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(ENV_KEYS as readonly string[]).includes(key)) {
      problems.push(`dollas:adoptEnv lists ${key}, which this recipe does not manage. Leave it out; Pulumi will not touch it.`);
      continue;
    }
    if (key === "DATABASE_URL_APP") {
      problems.push("dollas:adoptEnv cannot list DATABASE_URL_APP: its password comes from Pulumi. Delete the hand-made variable in Vercel and let Pulumi create it.");
      continue;
    }
    const entries = Array.isArray(value) ? value : [value];
    const seen = new Set<VercelTarget>();
    const parsed: AdoptedEnv[] = [];
    for (const entry of entries) {
      const id = (entry as { id?: unknown })?.id;
      const targets = (entry as { targets?: unknown })?.targets;
      if (typeof id !== "string" || !id.trim()) {
        problems.push(`dollas:adoptEnv.${key} needs an id for each entry (the Vercel environment variable id).`);
        continue;
      }
      if (!Array.isArray(targets) || targets.length === 0) {
        problems.push(`dollas:adoptEnv.${key} entry ${id} needs targets, for example [production, preview].`);
        continue;
      }
      const clean: VercelTarget[] = [];
      for (const target of targets) {
        if (!(VERCEL_TARGETS as readonly string[]).includes(target as string)) {
          problems.push(`dollas:adoptEnv.${key} entry ${id} has target "${String(target)}"; use production or preview.`);
        } else if (seen.has(target as VercelTarget)) {
          problems.push(`dollas:adoptEnv.${key} lists ${String(target)} twice.`);
        } else {
          seen.add(target as VercelTarget);
          clean.push(target as VercelTarget);
        }
      }
      parsed.push({ id: id.trim(), targets: clean });
    }
    result[key as EnvKey] = parsed;
  }
  return result;
}

export function parseSettings<S>(source: SettingsSource<S>): Settings<S> {
  const problems: string[] = [];
  const plain = (key: PlainKey) => {
    const value = source.plain(key)?.trim();
    return value ? value : undefined;
  };
  const has = (key: SecretKey) => source.secret(key) !== undefined;

  const name = plain("projectName") ?? "dollas";
  if (!PROJECT_NAME.test(name)) problems.push(`dollas:projectName "${name}" must be lowercase letters, digits, ".", "_", or "-".`);
  const teamId = plain("vercelTeamId");
  if (teamId && !/^team_[A-Za-z0-9]+$/.test(teamId)) problems.push("dollas:vercelTeamId must look like team_...");
  const existingId = plain("vercelProjectId");
  if (existingId && !/^prj_[A-Za-z0-9]+$/.test(existingId)) problems.push("dollas:vercelProjectId must look like prj_...");
  const nodeVersion = plain("nodeVersion") ?? "24.x";
  if (!NODE_VERSION.test(nodeVersion)) problems.push(`dollas:nodeVersion "${nodeVersion}" must look like 24.x.`);
  const repo = plain("gitRepository");
  if (repo && !REPO.test(repo)) problems.push(`dollas:gitRepository "${repo}" must be owner/repo on GitHub.`);
  const productionBranch = plain("productionBranch") ?? "main";

  const domain = plain("domain")?.toLowerCase();
  if (domain && !HOSTNAME.test(domain)) problems.push(`dollas:domain "${domain}" is not a hostname (no scheme or path).`);

  let targets: VercelTarget[] = ["production", "preview"];
  try {
    targets = parseTargets(plain("vercelTargets"));
  } catch (error) {
    problems.push(...(error as SettingsError).problems);
  }
  const protect = parseBool(plain("protect"), "protect", Boolean(existingId), problems);

  const databaseEnv = plain("databaseEnv") ?? "pulumi";
  if (databaseEnv !== "pulumi" && databaseEnv !== "integration") {
    problems.push('dollas:databaseEnv must be "pulumi" (Pulumi sets DATABASE_URL and DATABASE_URL_UNPOOLED) or "integration" (the Neon Vercel integration does).');
  }
  const ownerUrl = source.secret("ownerDatabaseUrl");
  if (ownerUrl === undefined) problems.push("dollas:ownerDatabaseUrl is required (secret): the Postgres owner URL, direct (not pooled).");
  if (databaseEnv === "integration" && has("ownerPooledDatabaseUrl")) {
    problems.push("dollas:ownerPooledDatabaseUrl is only used with databaseEnv=pulumi; the integration sets DATABASE_URL.");
  }
  const appPasswordVersion = plain("appPasswordVersion") ?? "1";

  const adoptRaw = source.adoptEnv();
  const adopted = parseAdoptEnv(adoptRaw, problems);
  if (Object.keys(adopted).length > 0 && !existingId) {
    problems.push("dollas:adoptEnv needs dollas:vercelProjectId: variables can only be adopted from an existing project.");
  }
  if (existingId) {
    // Adopting is explicit so nothing is generated or created over variables that already exist.
    if (adoptRaw === undefined || adoptRaw === null) {
      problems.push("Adopting an existing project (dollas:vercelProjectId) needs dollas:adoptEnv: list every variable this recipe manages that already exists, or set it to {} if none do.");
    }
    if (!plain("databaseEnv")) {
      problems.push('Adopting an existing project needs dollas:databaseEnv set explicitly: "integration" if the Neon Vercel integration injects DATABASE_URL, otherwise "pulumi".');
    }
  }
  const adoptDomain = parseBool(plain("adoptDomain"), "adoptDomain", false, problems);
  if (adoptDomain && (!existingId || !domain)) problems.push("dollas:adoptDomain needs dollas:vercelProjectId and dollas:domain.");
  const configuredFor: Partial<Record<EnvKey, boolean>> = {
    BETTER_AUTH_URL: Boolean(plain("betterAuthUrl")),
    BETTER_AUTH_SECRET: has("betterAuthSecret"),
    BANK_CONNECTION_KEYS: has("bankConnectionKeys"),
    RESEND_API_KEY: has("resendApiKey"),
    RESEND_FROM: Boolean(plain("resendFrom")),
    GOOGLE_CLIENT_ID: has("googleClientId"),
    GOOGLE_CLIENT_SECRET: has("googleClientSecret"),
    PLAID_CLIENT_ID: has("plaidClientId"),
    PLAID_SECRET: has("plaidSecret"),
    PLAID_ENV: Boolean(plain("plaidEnv")),
    PLAID_REDIRECT_URI: Boolean(plain("plaidRedirectUri")),
  };
  for (const key of Object.keys(adopted) as EnvKey[]) {
    if (configuredFor[key]) {
      problems.push(`${key} is in dollas:adoptEnv and also set in config. Adopted variables keep the value already in Vercel; remove it from one of the two.`);
    }
  }
  if (databaseEnv === "integration") {
    for (const key of ["DATABASE_URL", "DATABASE_URL_UNPOOLED"] as const) {
      if (adopted[key]) problems.push(`dollas:adoptEnv lists ${key}, but databaseEnv=integration means the Neon integration owns it.`);
    }
  }

  // Values: config wins, then an adopted variable keeps Vercel's value, then a default.
  const betterAuthUrl = plain("betterAuthUrl") ?? (domain ? `https://${domain}` : undefined);
  if (betterAuthUrl) {
    try {
      const url = new URL(betterAuthUrl);
      if (url.protocol !== "https:" || url.pathname.replace(/\/+$/, "") !== "" || url.search) {
        problems.push(`dollas:betterAuthUrl "${betterAuthUrl}" must be an https origin with no path, like https://dollas.example.com.`);
      }
    } catch {
      problems.push(`dollas:betterAuthUrl "${betterAuthUrl}" is not a URL.`);
    }
  }
  const resendFrom = plain("resendFrom");
  if (resendFrom && !EMAIL.test(resendFrom)) problems.push(`dollas:resendFrom "${resendFrom}" must be an email address.`);
  const plaidEnv = plain("plaidEnv");
  if (plaidEnv && plaidEnv !== "sandbox" && plaidEnv !== "production") {
    problems.push(`dollas:plaidEnv "${plaidEnv}" must be sandbox or production (Trial is production).`);
  }
  const plaidRedirectUri = plain("plaidRedirectUri");
  if (plaidRedirectUri) {
    try {
      const url = new URL(plaidRedirectUri);
      const localSandbox = url.protocol === "http:" && url.hostname === "localhost" && plaidEnv === "sandbox";
      if (url.protocol !== "https:" && !localSandbox) problems.push("dollas:plaidRedirectUri must be https (http://localhost only with plaidEnv=sandbox).");
    } catch {
      problems.push(`dollas:plaidRedirectUri "${plaidRedirectUri}" is not a URL.`);
    }
  }

  const present = (key: EnvKey, configured: boolean) => configured || Boolean(adopted[key]);
  const together = (label: string, keys: Array<[EnvKey, boolean, string]>) => {
    const set = keys.filter(([key, configured]) => present(key, configured));
    if (set.length > 0 && set.length < keys.length) {
      const missing = keys.filter(([key, configured]) => !present(key, configured)).map(([, , configKey]) => `dollas:${configKey}`);
      problems.push(`${label}: set ${missing.join(" and ")} too, or none of them.`);
    }
  };
  together("Resend email", [
    ["RESEND_API_KEY", has("resendApiKey"), "resendApiKey"],
    ["RESEND_FROM", Boolean(resendFrom), "resendFrom"],
  ]);
  together("Google sign-in", [
    ["GOOGLE_CLIENT_ID", has("googleClientId"), "googleClientId"],
    ["GOOGLE_CLIENT_SECRET", has("googleClientSecret"), "googleClientSecret"],
  ]);
  together("Plaid", [
    ["PLAID_CLIENT_ID", has("plaidClientId"), "plaidClientId"],
    ["PLAID_SECRET", has("plaidSecret"), "plaidSecret"],
    ["PLAID_ENV", Boolean(plaidEnv), "plaidEnv"],
  ]);
  if (present("PLAID_REDIRECT_URI", Boolean(plaidRedirectUri)) && !present("PLAID_CLIENT_ID", has("plaidClientId"))) {
    problems.push("dollas:plaidRedirectUri needs the Plaid settings too.");
  }

  if (problems.length > 0) throw new SettingsError(problems);

  const env: EnvPlan<S>[] = [];
  const add = (key: EnvKey, sensitive: boolean, source: EnvSource<S> | undefined) => {
    const adoptedEntries = adopted[key];
    const resolved: EnvSource<S> | undefined = source ?? (adoptedEntries ? { kind: "keep" } : undefined);
    if (!resolved) return;
    const instances = adoptedEntries
      ? adoptedEntries.map((entry) => ({ targets: entry.targets, importId: entry.id }))
      : [{ targets }];
    env.push({ key, sensitive, source: resolved, instances });
  };
  const secret = (key: SecretKey): EnvSource<S> | undefined => {
    const value = source.secret(key);
    return value === undefined ? undefined : { kind: "secret", value };
  };
  const text = (value: string | undefined): EnvSource<S> | undefined => (value ? { kind: "plain", value } : undefined);

  if (databaseEnv === "pulumi") {
    add("DATABASE_URL", true, { kind: "database", which: "pooled" });
    add("DATABASE_URL_UNPOOLED", true, { kind: "database", which: "direct" });
  }
  add("DATABASE_URL_APP", true, { kind: "database", which: "app" });
  add("BETTER_AUTH_URL", false, adopted.BETTER_AUTH_URL ? undefined : text(betterAuthUrl));
  add("BETTER_AUTH_SECRET", true, secret("betterAuthSecret") ?? (adopted.BETTER_AUTH_SECRET ? undefined : { kind: "generated", generator: "betterAuthSecret" }));
  add("BANK_CONNECTION_KEYS", true, secret("bankConnectionKeys") ?? (adopted.BANK_CONNECTION_KEYS ? undefined : { kind: "generated", generator: "bankConnectionKeys" }));
  add("RESEND_API_KEY", true, secret("resendApiKey"));
  add("RESEND_FROM", false, text(resendFrom));
  add("GOOGLE_CLIENT_ID", true, secret("googleClientId"));
  add("GOOGLE_CLIENT_SECRET", true, secret("googleClientSecret"));
  add("PLAID_CLIENT_ID", true, secret("plaidClientId"));
  add("PLAID_SECRET", true, secret("plaidSecret"));
  add("PLAID_ENV", false, text(plaidEnv));
  add("PLAID_REDIRECT_URI", false, text(plaidRedirectUri));

  return {
    project: {
      name,
      teamId,
      existingId,
      framework: "nextjs",
      rootDirectory: "apps/web",
      installCommand: plain("installCommand"),
      buildCommand: plain("buildCommand"),
      nodeVersion,
      gitRepository: repo ? { type: "github", repo, productionBranch } : undefined,
    },
    domain,
    adoptDomain,
    targets,
    protect,
    database: {
      env: databaseEnv as "pulumi" | "integration",
      ownerUrl: ownerUrl as S,
      pooledUrl: source.secret("ownerPooledDatabaseUrl"),
      appHost: plain("appDatabaseHost"),
      appPasswordVersion,
    },
    env,
  };
}

/** Pulumi resource name for one Vercel variable. DATABASE_URL_APP keeps its PEN-214 name. */
export function envResourceName(key: EnvKey, targets: VercelTarget[], split: boolean): string {
  if (key === "DATABASE_URL_APP" && !split) return "database-url-app";
  const base = `env-${key.toLowerCase().replace(/_/g, "-")}`;
  return split ? `${base}-${[...targets].sort().join("-")}` : base;
}

// Secret content validators, applied by the program inside `apply`.

export function checkPostgresUrl(label: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a URL.`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error(`${label} must be a postgres:// or postgresql:// URL.`);
  if (!url.username || !url.password) throw new Error(`${label} must include the owner user and password.`);
  if (!url.pathname.replace(/^\//, "")) throw new Error(`${label} must name a database.`);
  return value;
}

/** BANK_CONNECTION_KEYS: comma-separated version:base64 entries, each 32 bytes, versions unique. */
export function checkBankConnectionKeys(value: string): string {
  const seen = new Set<number>();
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error("dollas:bankConnectionKeys is empty.");
  for (const entry of entries) {
    const match = /^(\d+):([A-Za-z0-9+/]+={0,2})$/.exec(entry);
    if (!match) throw new Error("dollas:bankConnectionKeys entries must be version:base64, like 1:AbC...=");
    const version = Number(match[1]);
    if (version < 1 || seen.has(version)) throw new Error("dollas:bankConnectionKeys versions must be positive and unique.");
    seen.add(version);
    if (Buffer.from(match[2] ?? "", "base64").length !== 32) throw new Error(`dollas:bankConnectionKeys version ${version} must decode to 32 bytes.`);
  }
  return value;
}

export function checkBetterAuthSecret(value: string): string {
  if (value.trim().length < 32) throw new Error("dollas:betterAuthSecret must be at least 32 characters.");
  return value;
}

export function checkNotBlank(label: string, value: string): string {
  if (!value.trim()) throw new Error(`${label} is blank.`);
  return value;
}

/** A generated bank key ring: version 1 with 32 random bytes. */
export function bankKeyRing(base64: string): string {
  return checkBankConnectionKeys(`1:${base64}`);
}
