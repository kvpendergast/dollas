import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { redactSecrets } from "../lib/redact";
import { ASSUME_APP_ROLE_SQL, isSubjectToRowLevelSecurity, type RoleSecurityFacts } from "./app-role";

/**
 * Session lock shared by every cold start. Direct connections only: PgBouncer
 * transaction pooling would drop it, which is why startup prefers
 * DATABASE_URL_UNPOOLED.
 */
const MIGRATION_LOCK = [4812, 1001] as const;

/**
 * Non-owner role used for household queries. Docker already creates a LOGIN
 * role for local development. A fresh Neon database does not. Neon rejects
 * passwords below 60 bits of entropy, so this statement has no password.
 * NOLOGIN is enough: the migration role is granted this role, and each app
 * transaction assumes it so row-level security applies to the table owner too.
 */
export const APP_ROLE_SQL = "CREATE ROLE dollas_app NOLOGIN NOSUPERUSER NOBYPASSRLS";

/**
 * Re-applied on every owner startup. Migration 0001 grants only when the role
 * already exists, and an existing Neon database may have migrated first.
 * INSERT stays revoked on household, household_member, and household_invite.
 * Invites are created, revoked, and accepted only through the 0022 functions.
 */
export const APP_GRANT_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dollas_app') THEN
    RETURN;
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO dollas_app', current_database());
  GRANT USAGE ON SCHEMA public TO dollas_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON "user", session, account, verification TO dollas_app;
  REVOKE ALL ON household FROM dollas_app;
  GRANT SELECT, UPDATE ON household TO dollas_app;
  REVOKE ALL ON household_member FROM dollas_app;
  GRANT SELECT ON household_member TO dollas_app;
  REVOKE ALL ON household_invite FROM dollas_app;
  GRANT SELECT ON household_invite TO dollas_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ledger_account, category, category_group, category_budget, transaction, transaction_split, payee_category_rule, bank_connection, bank_account, csv_import, csv_column_mapping TO dollas_app;
  GRANT EXECUTE ON FUNCTION app_user_id() TO dollas_app;
  GRANT EXECUTE ON FUNCTION app_can_access_household(uuid) TO dollas_app;
  GRANT EXECUTE ON FUNCTION create_household(text) TO dollas_app;
  REVOKE ALL ON FUNCTION create_household_invite(text, text, text, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION revoke_household_invite(text, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION household_invite_preview(text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION accept_household_invite(text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION create_household_invite(text, text, text, text) TO dollas_app;
  GRANT EXECUTE ON FUNCTION revoke_household_invite(text, text) TO dollas_app;
  GRANT EXECUTE ON FUNCTION household_invite_preview(text) TO dollas_app;
  GRANT EXECUTE ON FUNCTION accept_household_invite(text) TO dollas_app;
  REVOKE ALL ON FUNCTION leave_household(text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION transfer_household_ownership(text, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION delete_household(text, text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION leave_household(text) TO dollas_app;
  GRANT EXECUTE ON FUNCTION transfer_household_ownership(text, text) TO dollas_app;
  GRANT EXECUTE ON FUNCTION delete_household(text, text) TO dollas_app;
  GRANT dollas_app TO current_user;
END
$$;
`;

/**
 * Books tables created before this Drizzle journal (the previous SQL migration)
 * already include functions, grants, and row-level security. Stamp the journal
 * at this migration so those statements are not run again. Anything generated
 * after it still applies.
 */
const LEGACY_BASELINE_TAG = "0002_household_rls";

export type JournalEntry = {
  tag: string;
  when: number;
};

export type MigrationResult = {
  applied: string[];
  skipped: string[];
};

export type MigrationSession = {
  lock(): Promise<void>;
  unlock(): Promise<void>;
  end(): Promise<void>;
  canCreateSchema(): Promise<boolean>;
  booksSchemaPresent(): Promise<boolean>;
  /** Latest journal created_at. Null when the journal is missing or empty. */
  latestJournalAt(): Promise<number | null | "unreadable">;
  ensureAppRole(): Promise<void>;
  baselineLegacy(createdAt: number): Promise<void>;
  migrate(folder: string): Promise<void>;
  grantAppAccess(): Promise<void>;
  grantJournalRead(): Promise<void>;
};

export type MigrateOnStartupOptions = {
  env?: Record<string, string | undefined>;
  folder?: string;
  journal?: JournalEntry[];
  connect?: (url: string) => MigrationSession;
};

let startupTask: Promise<MigrationResult> | undefined;

/**
 * URL for schema changes when the app process starts.
 * DATABASE_MIGRATE_URL is intentionally not consulted: Vercel does not set it.
 */
export function startupDatabaseUrl(env: Record<string, string | undefined>): string {
  const direct = env.DATABASE_URL_UNPOOLED?.trim();
  if (direct) return direct;
  const pooled = env.DATABASE_URL?.trim();
  if (pooled) return pooled;
  throw new Error("DATABASE_URL is required");
}

/**
 * Same skip rule as drizzle-orm: a migration runs only when the latest journal
 * created_at is strictly older than that migration's folder timestamp.
 */
export function pendingMigrationTags(journal: JournalEntry[], lastCreatedAt: number | null): string[] {
  return journal.filter((entry) => lastCreatedAt == null || lastCreatedAt < entry.when).map((entry) => entry.tag);
}

export function legacyBaselineAt(journal: JournalEntry[]): number {
  const marker = journal.find((entry) => entry.tag === LEGACY_BASELINE_TAG);
  if (marker) return marker.when;
  return journal.reduce((max, entry) => Math.max(max, entry.when), 0);
}

export function migrateOnStartup(options?: MigrateOnStartupOptions): Promise<MigrationResult> {
  if (options) return runStartup(options);
  if (!startupTask) {
    startupTask = runStartup({}).catch((error: unknown) => {
      startupTask = undefined;
      throw error;
    });
  }
  return startupTask;
}

export async function migrateWithUrl(url: string, options?: MigrateOnStartupOptions): Promise<MigrationResult> {
  const folder = options?.folder ?? migrationsFolder();
  const journal = options?.journal ?? readJournal(folder);
  const connect = options?.connect ?? createPostgresMigrationSession;
  const session = connect(url);
  try {
    return await applyMigrations(session, journal, folder);
  } finally {
    await session.end();
  }
}

async function runStartup(options: MigrateOnStartupOptions): Promise<MigrationResult> {
  const env = options.env ?? process.env;
  try {
    const url = startupDatabaseUrl(env);
    const result = await migrateWithUrl(url, options);
    if (result.applied.length > 0) {
      console.log(`Applied schema migrations: ${result.applied.join(", ")}`);
    }
    if (!options.connect) await assertAppRoleSubjectToRls(url);
    return result;
  } catch (error) {
    console.error(`Startup schema migration failed: ${publicErrorText(error)}`);
    throw error;
  }
}

export async function applyMigrations(
  session: MigrationSession,
  journal: JournalEntry[],
  folder: string,
): Promise<MigrationResult> {
  let locked = false;
  try {
    await session.lock();
    locked = true;
    return await applyLocked(session, journal, folder);
  } finally {
    if (locked) {
      try {
        await session.unlock();
      } catch (error) {
        console.error(`Failed to release the schema migration lock: ${publicErrorText(error)}`);
      }
    }
  }
}

async function applyLocked(
  session: MigrationSession,
  journal: JournalEntry[],
  folder: string,
): Promise<MigrationResult> {
  const tags = journal.map((entry) => entry.tag);
  if (!(await session.canCreateSchema())) return await finishWithoutOwnership(session, journal);

  try {
    await session.ensureAppRole();
  } catch (error) {
    // Schema apply must not depend on this role. Serving without it is refused
    // after migrations, when the app role cannot be assumed.
    console.error(`Could not create the dollas_app role: ${publicErrorText(error)}`);
  }
  const latest = await session.latestJournalAt();
  if ((await session.booksSchemaPresent()) && latest == null) {
    await session.baselineLegacy(legacyBaselineAt(journal));
  }

  const current = await session.latestJournalAt();
  const lastCreatedAt = typeof current === "number" ? current : null;
  const pending = pendingMigrationTags(journal, lastCreatedAt);
  if (pending.length === 0) {
    await session.grantAppAccess();
    await session.grantJournalRead();
    return { applied: [], skipped: tags };
  }

  await session.migrate(folder);
  await session.grantAppAccess();
  await session.grantJournalRead();
  return {
    applied: pending,
    skipped: tags.filter((tag) => !pending.includes(tag)),
  };
}

async function finishWithoutOwnership(session: MigrationSession, journal: JournalEntry[]): Promise<MigrationResult> {
  const tags = journal.map((entry) => entry.tag);
  const booksPresent = await session.booksSchemaPresent();
  const latest = await session.latestJournalAt();

  if (!booksPresent && (latest === "unreadable" || latest == null)) {
    throw new Error(
      "This database role cannot apply migrations, and the books schema is missing. Startup uses DATABASE_URL_UNPOOLED when set, otherwise DATABASE_URL. Locally, run pnpm db:migrate with DATABASE_MIGRATE_URL.",
    );
  }

  if (latest === "unreadable" || latest == null) {
    console.warn(
      "Skipping startup migrations: this database role cannot change the schema, and the books tables are already present. Local development applies schema changes with pnpm db:migrate.",
    );
    return { applied: [], skipped: tags };
  }

  const pending = pendingMigrationTags(journal, latest);
  if (pending.length === 0) return { applied: [], skipped: tags };

  throw new Error(
    `Pending migrations (${pending.join(", ")}) cannot be applied by this database role. Locally, run pnpm db:migrate. On Vercel, DATABASE_URL_UNPOOLED or DATABASE_URL must be allowed to change the schema.`,
  );
}

export function readJournal(folder: string): JournalEntry[] {
  const journalPath = path.join(folder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: Array<{ tag: string; when: number }>;
  };
  return journal.entries.map((entry) => ({ tag: entry.tag, when: entry.when }));
}

export function migrationFolderCandidates(cwd: string, moduleDirectory: string): string[] {
  return [
    path.join(cwd, "drizzle"),
    path.join(cwd, "apps", "web", "drizzle"),
    // Source file lives at apps/web/src/db. The traced server chunk lives at
    // apps/web/.next/server/chunks. One of these two relative paths is the journal.
    path.join(moduleDirectory, "..", "..", "drizzle"),
    path.join(moduleDirectory, "..", "..", "..", "drizzle"),
  ];
}

export function resolveMigrationsFolder(candidates: string[]): string {
  for (const folder of candidates) {
    if (existsSync(path.join(folder, "meta", "_journal.json"))) return folder;
  }
  throw new Error(
    `Could not find drizzle/meta/_journal.json. Looked in: ${candidates.join(", ")}. Startup schema apply needs the Drizzle migrations in the server bundle.`,
  );
}

export function migrationsFolder(): string {
  return resolveMigrationsFolder(
    migrationFolderCandidates(process.cwd(), path.dirname(fileURLToPath(import.meta.url))),
  );
}

/**
 * Connects with the migration URL and assumes dollas_app for one transaction.
 * Startup refuses to serve when that role is missing, cannot be assumed, or
 * can bypass row-level security. The connection string is never included.
 */
export async function assertAppRoleSubjectToRls(url: string): Promise<void> {
  const sql = postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: 30,
    connection: { application_name: "dollas-rls-check" },
    onnotice() {},
  });
  try {
    const facts = await sql.begin(async (tx) => {
      await tx.unsafe(ASSUME_APP_ROLE_SQL);
      const rows = await tx<RoleSecurityFacts[]>`
        select
          current_user as "currentUser",
          r.rolsuper as "superuser",
          r.rolbypassrls as "bypassrls",
          (r.oid = c.relowner) as "ownsHousehold",
          c.relforcerowsecurity as "forceRls",
          c.relrowsecurity as "rlsEnabled"
        from pg_roles r
        join pg_class c on c.relname = 'household'
        join pg_namespace n on n.oid = c.relnamespace
        where r.rolname = current_user
          and n.nspname = 'public'
      `;
      return rows[0];
    });
    if (!facts) {
      throw new Error("The household table is missing, so row-level security cannot be confirmed for dollas_app.");
    }
    if (!isSubjectToRowLevelSecurity(facts)) {
      throw new Error(
        "dollas_app can bypass row-level security. Household queries must run as that non-owner role, without superuser or BYPASSRLS.",
      );
    }
  } catch (error) {
    if (isReportedAppRoleError(error)) throw error;
    const code = postgresErrorCode(error);
    if (code === "42501" || code === "28000" || code === "42704") {
      throw new Error(
        "The database login cannot assume dollas_app, so household queries would bypass row-level security. Startup grants dollas_app to the migration role after creating that NOLOGIN role.",
      );
    }
    throw new Error(`Could not confirm dollas_app is subject to row-level security (${code ?? "error"}).`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export function publicErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Unknown error";
  const message = redactSecrets(raw);
  const code = postgresErrorCode(error);
  return code ? `${code} ${message}` : message;
}

export function createPostgresMigrationSession(url: string): MigrationSession {
  const sql = postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: 30,
    connection: { application_name: "dollas-migrate" },
    onnotice() {},
  });

  return {
    async lock() {
      await sql`select pg_advisory_lock(${MIGRATION_LOCK[0]}, ${MIGRATION_LOCK[1]})`;
    },
    async unlock() {
      await sql`select pg_advisory_unlock(${MIGRATION_LOCK[0]}, ${MIGRATION_LOCK[1]})`;
    },
    async end() {
      await sql.end({ timeout: 5 });
    },
    async canCreateSchema() {
      const rows = await sql<{ ok: boolean }[]>`
        select has_database_privilege(current_user, current_database(), 'CREATE') as ok
      `;
      return rows[0]?.ok === true;
    },
    async booksSchemaPresent() {
      const rows = await sql<{ household: string | null }[]>`
        select to_regclass('public.household')::text as household
      `;
      return rows[0]?.household != null;
    },
    async latestJournalAt() {
      try {
        const exists = await sql<{ rel: string | null }[]>`
          select to_regclass('drizzle.__drizzle_migrations')::text as rel
        `;
        if (exists[0]?.rel == null) return null;
        const rows = await sql<{ created_at: string | number | null }[]>`
          select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1
        `;
        const value = rows[0]?.created_at;
        if (value == null) return null;
        return Number(value);
      } catch (error) {
        if (postgresErrorCode(error) === "42501" || postgresErrorCode(error) === "42P01") return "unreadable";
        throw error;
      }
    },
    async ensureAppRole() {
      const existing = await sql`select 1 from pg_roles where rolname = 'dollas_app'`;
      if (existing.length === 0) await sql.unsafe(APP_ROLE_SQL);
      // Vercel must not keep a login. An earlier boot may have created dollas_app
      // with the local password before Neon rejected it; NOLOGIN closes that.
      // Local migrate leaves LOGIN alone so DATABASE_URL can still connect.
      if (process.env.VERCEL) {
        await sql.unsafe("ALTER ROLE dollas_app NOLOGIN NOSUPERUSER NOBYPASSRLS");
      } else {
        await sql.unsafe("ALTER ROLE dollas_app NOSUPERUSER NOBYPASSRLS");
      }
    },
    async baselineLegacy(createdAt) {
      if (!Number.isSafeInteger(createdAt)) throw new Error("Invalid migration timestamp");
      await sql.unsafe("CREATE SCHEMA IF NOT EXISTS drizzle");
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
          id SERIAL PRIMARY KEY,
          hash text NOT NULL,
          created_at bigint
        )
      `);
      const count = await sql<{ n: string }[]>`select count(*)::text as n from drizzle.__drizzle_migrations`;
      if (count[0]?.n !== "0") return;
      await sql.unsafe(
        `insert into drizzle.__drizzle_migrations (hash, created_at) values ('baseline', ${createdAt})`,
      );
    },
    async migrate(folder) {
      await migrate(drizzle(sql), { migrationsFolder: folder });
    },
    async grantAppAccess() {
      const role = await sql`select 1 from pg_roles where rolname = 'dollas_app'`;
      if (role.length === 0) return;
      const household = await sql<{ household: string | null }[]>`
        select to_regclass('public.household')::text as household
      `;
      if (household[0]?.household == null) return;
      await sql.unsafe(APP_GRANT_SQL);
    },
    async grantJournalRead() {
      try {
        await sql.unsafe(`
          DO $$
          BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dollas_app') THEN
              GRANT USAGE ON SCHEMA drizzle TO dollas_app;
              GRANT SELECT ON drizzle.__drizzle_migrations TO dollas_app;
            END IF;
          END
          $$;
        `);
      } catch (error) {
        console.warn(`Could not grant drizzle journal read access: ${publicErrorText(error)}`);
      }
    },
  };
}

function isReportedAppRoleError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message.startsWith("The household table is missing") ||
      error.message.startsWith("dollas_app can bypass row-level security"))
  );
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}
