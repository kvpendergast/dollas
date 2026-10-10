import postgres from "postgres";
import { APP_ROLE } from "./app-role";

/**
 * Which URL the app pool uses (web pages, server actions, Better Auth, and
 * /api/mcp all share it through getDb).
 *
 * - "login": DATABASE_URL_APP is set. The pool logs in as dollas_app, created
 *   by infra/ (PEN-214), so row-level security binds the connection itself.
 * - "bridge": DATABASE_URL only. On Vercel that is the Neon owner, so each
 *   transaction runs SET LOCAL ROLE dollas_app (PEN-213). Delete this mode
 *   once every environment sets DATABASE_URL_APP.
 */
export type AppPoolConfig = { mode: "login"; url: string } | { mode: "bridge"; url: string };

export const APP_URL_ENV = "DATABASE_URL_APP";

export function appPoolConfig(env: Record<string, string | undefined>): AppPoolConfig {
  const app = env[APP_URL_ENV]?.trim();
  if (app) return { mode: "login", url: app };
  const pooled = env.DATABASE_URL?.trim();
  if (pooled) return { mode: "bridge", url: pooled };
  throw new Error("DATABASE_URL_APP or DATABASE_URL is required");
}

export const BRIDGE_WARNING =
  "DATABASE_URL_APP is not set, so the app pool connects with DATABASE_URL and relies on SET LOCAL ROLE dollas_app in every transaction (the PEN-213 bridge). Create the dollas_app login with infra/ (see infra/README.md) so row-level security binds the connection.";

/**
 * The warning, or null. A DATABASE_URL that already logs in as dollas_app
 * (local Docker) is not using the owner, so there is nothing to warn about.
 */
export function bridgeWarning(config: AppPoolConfig): string | null {
  if (config.mode === "login") return null;
  let user = "";
  try {
    user = decodeURIComponent(new URL(config.url).username);
  } catch {
    return BRIDGE_WARNING;
  }
  return user === APP_ROLE ? null : BRIDGE_WARNING;
}

/** What the dollas_app login reports about itself. */
export type AppLoginFacts = {
  currentUser: string;
  superuser: boolean;
  bypassrls: boolean;
  createrole: boolean;
  createdb: boolean;
  neonSuperuser: boolean;
  privilegedMember: boolean;
  ownsHousehold: boolean;
  forceRls: boolean;
  rlsEnabled: boolean | null;
};

/** Every reason this login must not serve household queries. Empty means safe. */
export function appLoginProblems(facts: AppLoginFacts): string[] {
  const problems: string[] = [];
  if (facts.currentUser !== APP_ROLE) problems.push(`logs in as ${facts.currentUser || "an unknown role"}, not ${APP_ROLE}`);
  if (facts.superuser) problems.push("is a superuser");
  if (facts.bypassrls) problems.push("has BYPASSRLS");
  if (facts.neonSuperuser) problems.push("is a member of neon_superuser");
  if (facts.privilegedMember) problems.push("is a member of a superuser or BYPASSRLS role");
  if (facts.createrole) problems.push("has CREATEROLE");
  if (facts.createdb) problems.push("has CREATEDB");
  if (facts.rlsEnabled === null) problems.push("cannot see the household table");
  else if (!facts.rlsEnabled) problems.push("household row-level security is off");
  if (facts.ownsHousehold && !facts.forceRls) problems.push("owns the household table");
  return problems;
}

export function appLoginError(problems: string[]): Error {
  return new Error(
    `DATABASE_URL_APP must log in as dollas_app subject to row-level security. Refusing to serve: it ${problems.join("; ")}. Recreate the login with infra/ (see infra/README.md).`,
  );
}

/**
 * Fail-closed startup check for DATABASE_URL_APP. Never includes the URL.
 */
export async function assertAppLogin(url: string): Promise<void> {
  const sql = postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: 30,
    connection: { application_name: "dollas-app-login-check" },
    onnotice() {},
  });
  let facts: AppLoginFacts | undefined;
  try {
    const rows = await sql<AppLoginFacts[]>`
      select
        current_user as "currentUser",
        r.rolsuper as "superuser",
        r.rolbypassrls as "bypassrls",
        r.rolcreaterole as "createrole",
        r.rolcreatedb as "createdb",
        case when exists (select 1 from pg_roles where rolname = 'neon_superuser')
          then pg_has_role(current_user, 'neon_superuser', 'MEMBER') else false end as "neonSuperuser",
        exists (
          select 1 from pg_roles s
          where s.oid <> r.oid and (s.rolsuper or s.rolbypassrls) and pg_has_role(current_user, s.oid, 'MEMBER')
        ) as "privilegedMember",
        coalesce(c.relowner = r.oid, false) as "ownsHousehold",
        coalesce(c.relforcerowsecurity, false) as "forceRls",
        c.relrowsecurity as "rlsEnabled"
      from pg_roles r
      left join pg_class c on c.oid = to_regclass('public.household')
      where r.rolname = current_user
    `;
    facts = rows[0];
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "error";
    throw new Error(`Could not log in with DATABASE_URL_APP to confirm it is dollas_app (${code}). Refusing to serve.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
  if (!facts) throw appLoginError(["has no pg_roles row"]);
  const problems = appLoginProblems(facts);
  if (problems.length > 0) throw appLoginError(problems);
}
