import { readFileSync } from "node:fs";
import path from "node:path";

export const APP_ROLE = "dollas_app";

/** Placeholder in sql/dollas-app-login.sql, in psql's quoted-variable form. */
export const PASSWORD_PLACEHOLDER = ":'app_password'";

/** Alphanumeric so it needs no escaping in SQL or in a URL. 48 chars is about 285 bits. */
export const APP_PASSWORD_LENGTH = 48;
const STRONG_PASSWORD = /^[A-Za-z0-9]{32,}$/;

export function appLoginSqlPath(): string {
  return path.resolve(__dirname, "..", "..", "sql", "dollas-app-login.sql");
}

export function loadAppLoginSql(file = appLoginSqlPath()): string {
  return readFileSync(file, "utf8");
}

/**
 * Fills in the password. ALTER ROLE takes no bind parameters, so the value is
 * inlined; it must be the long alphanumeric password Pulumi generates.
 */
export function renderAppLoginSql(template: string, password: string): string {
  if (!STRONG_PASSWORD.test(password)) {
    throw new Error("The dollas_app password must be at least 32 letters and digits.");
  }
  const parts = template.split(PASSWORD_PLACEHOLDER);
  // Comments may mention the placeholder by name but not in its quoted form.
  if (parts.length !== 2) throw new Error(`Expected one ${PASSWORD_PLACEHOLDER} in the dollas_app SQL.`);
  return parts.join(`'${password}'`);
}

/**
 * Neon's pooled host is the endpoint id plus "-pooler". Serverless functions
 * should use it, like the integration's DATABASE_URL. Other hosts are kept.
 */
export function pooledHost(host: string): string {
  const [first, ...rest] = host.split(".");
  if (!host.endsWith(".neon.tech") || !first?.startsWith("ep-") || first.endsWith("-pooler")) return host;
  return [`${first}-pooler`, ...rest].join(".");
}

/**
 * DATABASE_URL_APP: dollas_app on the owner URL's database, on the pooled host
 * unless one is given. TLS options (sslmode, channel_binding) are kept.
 */
export function appDatabaseUrl(ownerDatabaseUrl: string, password: string, host?: string): string {
  const owner = new URL(ownerDatabaseUrl);
  if (owner.protocol !== "postgres:" && owner.protocol !== "postgresql:") {
    throw new Error("ownerDatabaseUrl must be a postgres:// or postgresql:// URL.");
  }
  const database = owner.pathname.replace(/^\//, "");
  if (!database) throw new Error("ownerDatabaseUrl must name a database.");
  const url = new URL(`postgresql://${host?.trim() || pooledHost(owner.hostname)}`);
  if (!host && owner.port) url.port = owner.port;
  url.username = APP_ROLE;
  url.password = password;
  url.pathname = `/${database}`;
  for (const key of ["sslmode", "channel_binding"]) {
    const value = owner.searchParams.get(key);
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

/** The URL the dynamic provider uses to prove the new password logs in (direct host). */
export function appDirectUrl(ownerDatabaseUrl: string, password: string): string {
  const owner = new URL(ownerDatabaseUrl);
  return appDatabaseUrl(ownerDatabaseUrl, password, owner.port ? `${owner.hostname}:${owner.port}` : owner.hostname);
}
