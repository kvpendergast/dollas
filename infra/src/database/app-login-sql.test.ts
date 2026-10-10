import { describe, expect, it } from "vitest";
import { appDatabaseUrl, appDirectUrl, loadAppLoginSql, pooledHost, renderAppLoginSql } from "./app-login-sql";
import { parseTargets } from "../config";

const STRONG = "A".repeat(20) + "b".repeat(20) + "12345678";
const OWNER = "postgresql://neondb_owner:owner-secret@ep-quiet-sky-123456.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

describe("dollas_app SQL", () => {
  const template = loadAppLoginSql();
  const code = template.replace(/--.*$/gm, "");

  it("creates the role without privileged attributes and never grants neon_superuser", () => {
    expect(template).toMatch(/CREATE ROLE dollas_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION/);
    expect(template).toMatch(/ALTER ROLE dollas_app WITH LOGIN NOCREATEROLE NOCREATEDB PASSWORD :'app_password'/);
    expect(code).not.toMatch(/GRANT\s+neon_superuser/i);
    expect(template).not.toMatch(/(CREATE|ALTER) ROLE dollas_app[^;]*\s(SUPERUSER|BYPASSRLS|REPLICATION|CREATEROLE|CREATEDB)\b/);
    expect(template).toMatch(/RAISE EXCEPTION 'dollas_app is a member of neon_superuser/);
  });

  it("inlines only a long alphanumeric password", () => {
    const sql = renderAppLoginSql(template, STRONG);
    expect(sql).toContain(`PASSWORD '${STRONG}'`);
    expect(sql).not.toContain(":'app_password'");
    expect(() => renderAppLoginSql(template, "short1")).toThrow(/32 letters/);
    expect(() => renderAppLoginSql(template, `${STRONG}'; drop table household; --`)).toThrow(/32 letters/);
    expect(() => renderAppLoginSql("no placeholder", STRONG)).toThrow(/Expected one/);
  });
});

describe("DATABASE_URL_APP", () => {
  it("uses Neon's pooled host and keeps TLS options", () => {
    const url = new URL(appDatabaseUrl(OWNER, STRONG));
    expect(url.username).toBe("dollas_app");
    expect(url.password).toBe(STRONG);
    expect(url.hostname).toBe("ep-quiet-sky-123456-pooler.us-east-2.aws.neon.tech");
    expect(url.pathname).toBe("/neondb");
    expect(url.searchParams.get("sslmode")).toBe("require");
    expect(url.searchParams.get("channel_binding")).toBe("require");
    expect(url.toString()).not.toContain("owner-secret");
  });

  it("honours an explicit host and leaves non-Neon hosts alone", () => {
    expect(new URL(appDatabaseUrl(OWNER, STRONG, "db.example.test")).hostname).toBe("db.example.test");
    expect(pooledHost("ep-a-1-pooler.us-east-2.aws.neon.tech")).toBe("ep-a-1-pooler.us-east-2.aws.neon.tech");
    expect(pooledHost("127.0.0.1")).toBe("127.0.0.1");
    const local = new URL(appDirectUrl("postgresql://dollas:x@127.0.0.1:5432/dollas", STRONG));
    expect(local.host).toBe("127.0.0.1:5432");
    expect(new URL(appDirectUrl(OWNER, STRONG)).hostname).toBe("ep-quiet-sky-123456.us-east-2.aws.neon.tech");
  });

  it("rejects an owner URL that is not Postgres or names no database", () => {
    expect(() => appDatabaseUrl("mysql://u:p@h/db", STRONG)).toThrow(/postgres/);
    expect(() => appDatabaseUrl("postgresql://u:p@h", STRONG)).toThrow(/database/);
  });
});

describe("stack settings", () => {
  it("defaults Vercel targets to production and preview", () => {
    expect(parseTargets(undefined)).toEqual(["production", "preview"]);
    expect(parseTargets("production")).toEqual(["production"]);
    expect(() => parseTargets("staging")).toThrow(/staging/);
  });
});
