import { describe, expect, it } from "vitest";
import { adoptReport, type VercelEnvListing } from "./adopt";

const neon = (key: string): VercelEnvListing => ({ id: `n_${key}`, key, type: "encrypted", target: ["production", "preview", "development"], configurationId: "icfg_1" });

describe("adoptReport", () => {
  it("adopts recipe variables, skips integration and unrelated ones, keeps split targets", () => {
    const report = adoptReport([
      neon("DATABASE_URL"),
      neon("DATABASE_URL_UNPOOLED"),
      neon("PGHOST"),
      { id: "b1", key: "BANK_CONNECTION_KEYS", type: "sensitive", target: ["production", "preview"] },
      { id: "g1", key: "GOOGLE_CLIENT_ID", type: "sensitive", target: ["production"] },
      { id: "g2", key: "GOOGLE_CLIENT_ID", type: "encrypted", target: ["preview"] },
      { id: "u1", key: "BETTER_AUTH_URL", type: "plain", target: ["production", "preview"] },
      { id: "x1", key: "SOMETHING_ELSE", type: "plain", target: ["production"] },
    ]);
    expect(report.databaseEnv).toBe("integration");
    expect(report.commands).toEqual([
      "pulumi config set --plaintext --path 'dollas:adoptEnv.BETTER_AUTH_URL[0].id' u1",
      "pulumi config set --plaintext --path 'dollas:adoptEnv.BETTER_AUTH_URL[0].targets[0]' production",
      "pulumi config set --plaintext --path 'dollas:adoptEnv.BETTER_AUTH_URL[0].targets[1]' preview",
      "pulumi config set --plaintext --path 'dollas:adoptEnv.BANK_CONNECTION_KEYS[0].id' b1",
      "pulumi config set --plaintext --path 'dollas:adoptEnv.BANK_CONNECTION_KEYS[0].targets[0]' production",
      "pulumi config set --plaintext --path 'dollas:adoptEnv.BANK_CONNECTION_KEYS[0].targets[1]' preview",
      "pulumi config set --plaintext --path 'dollas:adoptEnv.GOOGLE_CLIENT_ID[0].id' g1",
      "pulumi config set --plaintext --path 'dollas:adoptEnv.GOOGLE_CLIENT_ID[0].targets[0]' production",
      "pulumi config set --plaintext --path 'dollas:adoptEnv.GOOGLE_CLIENT_ID[1].id' g2",
      "pulumi config set --plaintext --path 'dollas:adoptEnv.GOOGLE_CLIENT_ID[1].targets[0]' preview",
      "pulumi config set --plaintext --path 'dollas:adoptEnv.GOOGLE_CLIENT_ID[1].sensitive' false",
    ]);
    expect(report.notes).toEqual([]);
  });

  it("adopts hand-set database variables when there is no integration", () => {
    const report = adoptReport([{ id: "d1", key: "DATABASE_URL", type: "sensitive", target: ["production", "preview"] }]);
    expect(report.databaseEnv).toBe("pulumi");
    expect(report.commands[0]).toContain("dollas:adoptEnv.DATABASE_URL[0].id' d1");
  });

  it("explains what it leaves alone", () => {
    const report = adoptReport([
      { id: "a1", key: "DATABASE_URL_APP", type: "sensitive", target: ["production"] },
      { id: "r1", key: "RESEND_API_KEY", type: "sensitive", target: ["development"] },
      { id: "r2", key: "RESEND_FROM", type: "plain", target: ["production"], gitBranch: "staging" },
      { id: "p1", key: "PLAID_ENV", type: "plain", target: ["production", "development"] },
      { id: "s1", key: "RESEND_API_KEY", type: "sensitive", target: ["production"], configurationId: "icfg_resend" },
    ]);
    expect(report.notes).toEqual([
      expect.stringMatching(/DATABASE_URL_APP \(a1\) already exists/),
      expect.stringMatching(/RESEND_API_KEY \(r1\) only targets development/),
      expect.stringMatching(/RESEND_FROM \(r2\) is scoped to a git branch/),
      expect.stringMatching(/PLAID_ENV \(p1\) also targets development/),
      expect.stringMatching(/RESEND_API_KEY \(s1\) is owned by an integration/),
    ]);
    expect(report.commands).toContain("pulumi config set --plaintext --path 'dollas:adoptEnv.PLAID_ENV[0].targets[0]' production");
  });

  it("prints an empty adoptEnv when nothing matches", () => {
    expect(adoptReport([]).commands).toEqual(["pulumi config set --path 'dollas:adoptEnv' '{}'"]);
  });
});
