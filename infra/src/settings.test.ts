import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  bankKeyRing,
  checkBankConnectionKeys,
  checkBetterAuthSecret,
  checkPostgresUrl,
  ENV_KEYS,
  envResourceName,
  INSTALL_COMMAND,
  parseAdoptEnv,
  parseSettings,
  SettingsError,
  type EnvKey,
  type PlainKey,
  type SecretKey,
  type Settings,
} from "./settings";

type Input = Partial<Record<PlainKey | SecretKey, string>> & { adoptEnv?: unknown };

const OWNER = "postgresql://neondb_owner:owner-pw@ep-x.us-east-2.aws.neon.tech/neondb?sslmode=require";
const SECRET_KEYS = new Set<string>([
  "ownerDatabaseUrl",
  "ownerPooledDatabaseUrl",
  "betterAuthSecret",
  "bankConnectionKeys",
  "resendApiKey",
  "googleClientId",
  "googleClientSecret",
  "plaidClientId",
  "plaidSecret",
]);

function parse(input: Input): Settings<string> {
  return parseSettings<string>({
    plain: (key) => (SECRET_KEYS.has(key) ? undefined : input[key]),
    secret: (key) => input[key],
    adoptEnv: () => input.adoptEnv,
  });
}

function problems(input: Input): string[] {
  try {
    parse(input);
  } catch (error) {
    expect(error).toBeInstanceOf(SettingsError);
    return (error as SettingsError).problems;
  }
  throw new Error("expected a SettingsError");
}

const keys = (settings: Settings<string>) => settings.env.map((plan) => plan.key);
const plan = (settings: Settings<string>, key: EnvKey) => settings.env.find((entry) => entry.key === key);

/** Kyle's existing project: Neon integration, hand-set variables (ids from the Vercel API). */
const KYLE: Input = {
  vercelProjectId: "prj_BR3J6q8u5Mf2elb9J0Z5u4TQlrvN",
  vercelTeamId: "team_yhAulgIZyqJ2NaA2CU1yTZCn",
  gitRepository: "kvpendergast/dollas",
  databaseEnv: "integration",
  ownerDatabaseUrl: OWNER,
  adoptEnv: {
    BANK_CONNECTION_KEYS: [{ id: "JH23VDnntZcM4Hcb", targets: ["production", "preview"] }],
    GOOGLE_CLIENT_ID: [
      { id: "lGFuit0lrxGJzkVn", targets: ["production"] },
      { id: "fsWOrKEHo5nbigNt", targets: ["preview"] },
    ],
    GOOGLE_CLIENT_SECRET: [
      { id: "g1", targets: ["production"] },
      { id: "g2", targets: ["preview"] },
    ],
    RESEND_API_KEY: [{ id: "r1", targets: ["production", "preview"] }],
    RESEND_FROM: [{ id: "r2", targets: ["production", "preview"] }],
    BETTER_AUTH_URL: [{ id: "a1", targets: ["production", "preview"] }],
    BETTER_AUTH_SECRET: [{ id: "a2", targets: ["production", "preview"] }],
  },
};

describe("fresh fork", () => {
  it("needs only the owner URL and fills in safe defaults", () => {
    const settings = parse({ ownerDatabaseUrl: OWNER });
    expect(settings.project).toMatchObject({
      name: "dollas",
      framework: "nextjs",
      rootDirectory: "apps/web",
      nodeVersion: "24.x",
      existingId: undefined,
      gitRepository: undefined,
      installCommand: undefined,
      buildCommand: undefined,
    });
    expect(settings.targets).toEqual(["production", "preview"]);
    expect(settings.protect).toBe(false);
    expect(settings.database.env).toBe("pulumi");
    expect(keys(settings)).toEqual([
      "DATABASE_URL",
      "DATABASE_URL_UNPOOLED",
      "DATABASE_URL_APP",
      "BETTER_AUTH_SECRET",
      "BANK_CONNECTION_KEYS",
    ]);
    expect(plan(settings, "BETTER_AUTH_SECRET")?.source).toEqual({ kind: "generated", generator: "betterAuthSecret" });
    expect(plan(settings, "BANK_CONNECTION_KEYS")?.source).toEqual({ kind: "generated", generator: "bankConnectionKeys" });
    for (const entry of settings.env) {
      expect(entry.sensitive).toBe(true);
      expect(entry.instances).toEqual([{ targets: ["production", "preview"] }]);
    }
  });

  it("requires the owner URL", () => {
    expect(problems({})).toEqual([expect.stringMatching(/ownerDatabaseUrl is required/)]);
  });

  it("uses configured secrets instead of generating them", () => {
    const settings = parse({ ownerDatabaseUrl: OWNER, betterAuthSecret: "s".repeat(40), bankConnectionKeys: "1:abc" });
    expect(plan(settings, "BETTER_AUTH_SECRET")?.source).toEqual({ kind: "secret", value: "s".repeat(40) });
    expect(plan(settings, "BANK_CONNECTION_KEYS")?.source).toEqual({ kind: "secret", value: "1:abc" });
  });

  it("derives BETTER_AUTH_URL from the custom domain, plain (not sensitive)", () => {
    const settings = parse({ ownerDatabaseUrl: OWNER, domain: "Dollas.Example.com" });
    expect(settings.domain).toBe("dollas.example.com");
    expect(plan(settings, "BETTER_AUTH_URL")).toMatchObject({
      sensitive: false,
      source: { kind: "plain", value: "https://dollas.example.com" },
    });
    const explicit = parse({ ownerDatabaseUrl: OWNER, domain: "dollas.example.com", betterAuthUrl: "https://app.example.com" });
    expect(plan(explicit, "BETTER_AUTH_URL")?.source).toEqual({ kind: "plain", value: "https://app.example.com" });
  });

  it("leaves BETTER_AUTH_URL unset without a domain so the app uses Vercel's production URL", () => {
    expect(keys(parse({ ownerDatabaseUrl: OWNER }))).not.toContain("BETTER_AUTH_URL");
  });

  it("sets every optional integration when configured, secrets sensitive and the rest plain", () => {
    const settings = parse({
      ownerDatabaseUrl: OWNER,
      resendApiKey: "re_x",
      resendFrom: "Dollas <no-reply@example.com>".replace(/.*<|>/g, ""),
      googleClientId: "id.apps.googleusercontent.com",
      googleClientSecret: "gs",
      plaidClientId: "pc",
      plaidSecret: "ps",
      plaidEnv: "sandbox",
      plaidRedirectUri: "https://dollas.example.com/connections/plaid",
    });
    const sensitivity = Object.fromEntries(settings.env.map((entry) => [entry.key, entry.sensitive]));
    expect(sensitivity).toMatchObject({
      RESEND_API_KEY: true,
      RESEND_FROM: false,
      GOOGLE_CLIENT_ID: true,
      GOOGLE_CLIENT_SECRET: true,
      PLAID_CLIENT_ID: true,
      PLAID_SECRET: true,
      PLAID_ENV: false,
      PLAID_REDIRECT_URI: false,
    });
  });

  it("links a GitHub repository with a production branch", () => {
    expect(parse({ ownerDatabaseUrl: OWNER, gitRepository: "me/dollas" }).project.gitRepository).toEqual({
      type: "github",
      repo: "me/dollas",
      productionBranch: "main",
    });
  });

  it("uses a given pooled owner URL, and none with the Neon integration", () => {
    expect(parse({ ownerDatabaseUrl: OWNER, ownerPooledDatabaseUrl: "pooled" }).database.pooledUrl).toBe("pooled");
    const integration = parse({ ownerDatabaseUrl: OWNER, databaseEnv: "integration" });
    expect(keys(integration)).not.toContain("DATABASE_URL");
    expect(keys(integration)).not.toContain("DATABASE_URL_UNPOOLED");
    expect(keys(integration)).toContain("DATABASE_URL_APP");
    expect(problems({ ownerDatabaseUrl: OWNER, databaseEnv: "integration", ownerPooledDatabaseUrl: "x" })).toEqual([
      expect.stringMatching(/only used with databaseEnv=pulumi/),
    ]);
  });
});

describe("validation", () => {
  it.each<[string, Input, RegExp]>([
    ["project name", { projectName: "Dollas App" }, /projectName/],
    ["team id", { vercelTeamId: "yhAul" }, /team_/],
    ["project id", { vercelProjectId: "BR3J" }, /prj_/],
    ["node version", { nodeVersion: "24" }, /nodeVersion/],
    ["repository", { gitRepository: "https://github.com/me/dollas" }, /owner\/repo/],
    ["domain", { domain: "https://dollas.example.com" }, /not a hostname/],
    ["targets", { vercelTargets: "production,development" }, /development/],
    ["protect", { protect: "yes" }, /protect must be true or false/],
    ["database env", { databaseEnv: "neon" }, /databaseEnv must be/],
    ["auth URL scheme", { betterAuthUrl: "http://dollas.example.com" }, /https origin/],
    ["auth URL path", { betterAuthUrl: "https://dollas.example.com/app" }, /https origin/],
    ["auth URL", { betterAuthUrl: "dollas" }, /not a URL/],
    ["resend from", { resendFrom: "Dollas", resendApiKey: "re" }, /email address/],
    ["plaid env", { plaidEnv: "development", plaidClientId: "c", plaidSecret: "s" }, /sandbox or production/],
    ["plaid redirect", { plaidEnv: "production", plaidClientId: "c", plaidSecret: "s", plaidRedirectUri: "http://localhost:3000/x" }, /must be https/],
    ["adopt domain alone", { adoptDomain: "true" }, /adoptDomain needs/],
  ])("rejects a bad %s", (_label, input, pattern) => {
    expect(problems({ ownerDatabaseUrl: OWNER, ...input })).toEqual(expect.arrayContaining([expect.stringMatching(pattern)]));
  });

  it("allows a localhost Plaid redirect in sandbox", () => {
    const settings = parse({
      ownerDatabaseUrl: OWNER,
      plaidEnv: "sandbox",
      plaidClientId: "c",
      plaidSecret: "s",
      plaidRedirectUri: "http://localhost:3000/connections/plaid",
    });
    expect(keys(settings)).toContain("PLAID_REDIRECT_URI");
  });

  it.each<[string, Input, RegExp]>([
    ["Resend key without sender", { resendApiKey: "re" }, /Resend email: set dollas:resendFrom/],
    ["Resend sender without key", { resendFrom: "a@b.co" }, /Resend email: set dollas:resendApiKey/],
    ["Google id without secret", { googleClientId: "id" }, /Google sign-in: set dollas:googleClientSecret/],
    ["Plaid without env", { plaidClientId: "c", plaidSecret: "s" }, /Plaid: set dollas:plaidEnv/],
    ["Plaid redirect alone", { plaidRedirectUri: "https://x.example.com/p" }, /plaidRedirectUri needs the Plaid settings/],
  ])("requires pairs together: %s", (_label, input, pattern) => {
    expect(problems({ ownerDatabaseUrl: OWNER, ...input })).toEqual(expect.arrayContaining([expect.stringMatching(pattern)]));
  });

  it("reports every problem at once", () => {
    expect(problems({ projectName: "X", domain: "x", resendApiKey: "re" }).length).toBe(4);
  });
});

describe("adopting an existing project", () => {
  it("plans Kyle's project: integration database, adopted variables keep their values, no secrets generated", () => {
    const settings = parse(KYLE);
    expect(settings.project.existingId).toBe("prj_BR3J6q8u5Mf2elb9J0Z5u4TQlrvN");
    expect(settings.protect).toBe(true);
    expect(keys(settings)).toEqual([
      "DATABASE_URL_APP",
      "BETTER_AUTH_URL",
      "BETTER_AUTH_SECRET",
      "BANK_CONNECTION_KEYS",
      "RESEND_API_KEY",
      "RESEND_FROM",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
    ]);
    expect(plan(settings, "DATABASE_URL_APP")).toMatchObject({
      source: { kind: "database", which: "app" },
      instances: [{ targets: ["production", "preview"] }],
    });
    for (const key of keys(settings).filter((key) => key !== "DATABASE_URL_APP")) {
      expect(plan(settings, key)?.source).toEqual({ kind: "keep" });
    }
    expect(plan(settings, "GOOGLE_CLIENT_ID")?.instances).toEqual([
      { targets: ["production"], importId: "lGFuit0lrxGJzkVn" },
      { targets: ["preview"], importId: "fsWOrKEHo5nbigNt" },
    ]);
    // Same sensitivity as the existing variables, since changing it would replace them.
    expect(plan(settings, "BETTER_AUTH_URL")?.sensitive).toBe(false);
    expect(plan(settings, "RESEND_FROM")?.sensitive).toBe(false);
    expect(plan(settings, "BANK_CONNECTION_KEYS")?.sensitive).toBe(true);
  });

  it("keeps an adopted BETTER_AUTH_URL even when a domain is configured", () => {
    const settings = parse({ ...KYLE, domain: "dollas.example.com" });
    expect(plan(settings, "BETTER_AUTH_URL")?.source).toEqual({ kind: "keep" });
  });

  it("requires adoptEnv and databaseEnv to be explicit", () => {
    const { adoptEnv: _ignored, databaseEnv: _db, ...bare } = KYLE;
    expect(problems(bare)).toEqual([
      expect.stringMatching(/needs dollas:adoptEnv/),
      expect.stringMatching(/needs dollas:databaseEnv set explicitly/),
    ]);
    expect(parse({ ...bare, adoptEnv: {}, databaseEnv: "pulumi" }).env.every((entry) => !entry.instances[0]?.importId)).toBe(true);
  });

  it("rejects a variable that is both adopted and configured", () => {
    expect(problems({ ...KYLE, resendFrom: "a@b.co" })).toEqual([expect.stringMatching(/RESEND_FROM is in dollas:adoptEnv and also set/)]);
  });

  it("rejects adopting without a project, DATABASE_URL_APP, unknown keys, and integration-owned keys", () => {
    expect(problems({ ownerDatabaseUrl: OWNER, adoptEnv: { BETTER_AUTH_URL: [{ id: "x", targets: ["production"] }] } })).toEqual([
      expect.stringMatching(/needs dollas:vercelProjectId/),
    ]);
    expect(
      problems({
        ...KYLE,
        adoptEnv: {
          DATABASE_URL_APP: [{ id: "x", targets: ["production"] }],
          NEXT_PUBLIC_FOO: [{ id: "y", targets: ["production"] }],
          DATABASE_URL: [{ id: "z", targets: ["production"] }],
        },
      }),
    ).toEqual([
      expect.stringMatching(/cannot list DATABASE_URL_APP/),
      expect.stringMatching(/NEXT_PUBLIC_FOO, which this recipe does not manage/),
      expect.stringMatching(/Neon integration owns it/),
    ]);
  });

  it("checks adoptEnv entries", () => {
    const found: string[] = [];
    parseAdoptEnv(
      {
        RESEND_FROM: [{ targets: ["production"] }, { id: "a", targets: [] }, { id: "b", targets: ["development"] }],
        RESEND_API_KEY: [
          { id: "c", targets: ["production"] },
          { id: "d", targets: ["production"] },
        ],
      },
      found,
    );
    expect(found).toEqual([
      expect.stringMatching(/needs an id/),
      expect.stringMatching(/needs targets/),
      expect.stringMatching(/target "development"/),
      expect.stringMatching(/lists production twice/),
    ]);
    const shape: string[] = [];
    parseAdoptEnv(["nope"], shape);
    expect(shape).toEqual([expect.stringMatching(/must be a map/)]);
  });

  it("adopts an existing custom domain", () => {
    const settings = parse({ ...KYLE, domain: "dollas.example.com", adoptDomain: "true" });
    expect(settings.adoptDomain).toBe(true);
  });

  it("lets protection be turned off explicitly", () => {
    expect(parse({ ...KYLE, protect: "false" }).protect).toBe(false);
  });
});

describe("resource names", () => {
  it("keeps the PEN-214 name for DATABASE_URL_APP and names split variables by target", () => {
    expect(envResourceName("DATABASE_URL_APP", ["production", "preview"], false)).toBe("database-url-app");
    expect(envResourceName("BETTER_AUTH_SECRET", ["production", "preview"], false)).toBe("env-better-auth-secret");
    expect(envResourceName("GOOGLE_CLIENT_ID", ["production"], true)).toBe("env-google-client-id-production");
    expect(envResourceName("GOOGLE_CLIENT_ID", ["preview", "production"], true)).toBe("env-google-client-id-preview-production");
  });
});

describe("secret validators", () => {
  const key = Buffer.alloc(32, 7).toString("base64");

  it("accepts a key ring and a generated key", () => {
    expect(checkBankConnectionKeys(`2:${key},1:${key}`)).toBe(`2:${key},1:${key}`);
    expect(bankKeyRing(key)).toBe(`1:${key}`);
  });

  it.each([
    ["", /empty/],
    ["abc", /version:base64/],
    [`0:${key}`, /positive and unique/],
    [`1:${key},1:${key}`, /positive and unique/],
    [`1:${Buffer.alloc(16).toString("base64")}`, /32 bytes/],
  ])("rejects bank keys %j", (value, pattern) => {
    expect(() => checkBankConnectionKeys(value)).toThrow(pattern);
  });

  it("checks the Better Auth secret length", () => {
    expect(() => checkBetterAuthSecret("short")).toThrow(/32 characters/);
    expect(checkBetterAuthSecret("x".repeat(32))).toHaveLength(32);
  });

  it.each([
    ["nope", /not a URL/],
    ["mysql://u:p@h/db", /postgres/],
    ["postgres://h/db", /owner user and password/],
    ["postgres://u:p@h", /name a database/],
  ])("rejects owner URL %j", (value, pattern) => {
    expect(() => checkPostgresUrl("dollas:ownerDatabaseUrl", value)).toThrow(pattern);
  });

  it("accepts a Neon owner URL", () => {
    expect(checkPostgresUrl("x", OWNER)).toBe(OWNER);
  });
});

describe("repository contract", () => {
  it("matches the install command in apps/web/vercel.json, which the project leaves to the repo", () => {
    const vercelJson = JSON.parse(readFileSync(path.join(__dirname, "../../apps/web/vercel.json"), "utf8")) as { installCommand: string };
    expect(vercelJson.installCommand).toBe(INSTALL_COMMAND);
  });

  it("covers every variable the app reads that a deploy configures", () => {
    const appSecrets = readFileSync(path.join(__dirname, "../../packages/domain/src/setup/config.ts"), "utf8");
    const listed = /\(\?:([A-Z_|]+)\)/.exec(appSecrets)?.[1]?.split("|") ?? [];
    const notDeployed = new Set(["DATABASE_MIGRATE_URL"]); // local tooling only
    const expected = listed.filter((name) => !notDeployed.has(name)).sort();
    expect([...ENV_KEYS].sort()).toEqual(expected);
  });
});
