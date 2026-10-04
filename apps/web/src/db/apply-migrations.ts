import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Session lock shared by every cold start. Direct connections only: PgBouncer
 * transaction pooling would drop it, which is why startup prefers
 * DATABASE_URL_UNPOOLED.
 */
const MIGRATION_LOCK = [4812, 1001] as const;

/**
 * Local non-owner role. Docker already creates it. A fresh database (Neon on
 * first boot) needs the same role so the grants in the household migration
 * have a target. The password matches local development and is not a
 * production credential; the app connects with DATABASE_URL.
 */
export const APP_ROLE_SQL = "CREATE ROLE dollas_app LOGIN PASSWORD 'dollas' NOSUPERUSER NOBYPASSRLS";

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
  const url = startupDatabaseUrl(env);
  const result = await migrateWithUrl(url, options);
  if (result.applied.length > 0) {
    console.log(`Applied schema migrations: ${result.applied.join(", ")}`);
  }
  return result;
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
        console.error("Failed to release the schema migration lock", error);
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

  await session.ensureAppRole();
  const latest = await session.latestJournalAt();
  if ((await session.booksSchemaPresent()) && latest == null) {
    await session.baselineLegacy(legacyBaselineAt(journal));
  }

  const current = await session.latestJournalAt();
  const lastCreatedAt = typeof current === "number" ? current : null;
  const pending = pendingMigrationTags(journal, lastCreatedAt);
  if (pending.length === 0) {
    await session.grantJournalRead();
    return { applied: [], skipped: tags };
  }

  await session.migrate(folder);
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

export function migrationsFolder(): string {
  const candidates = [path.join(process.cwd(), "drizzle"), path.join(process.cwd(), "apps", "web", "drizzle")];
  for (const folder of candidates) {
    if (existsSync(path.join(folder, "meta", "_journal.json"))) return folder;
  }
  throw new Error(
    "Could not find drizzle/meta/_journal.json. Startup schema apply needs the Drizzle migrations in the server bundle.",
  );
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
      if (existing.length > 0) return;
      try {
        await sql.unsafe(APP_ROLE_SQL);
      } catch (error) {
        if (postgresErrorCode(error) === "42710") return;
        throw error;
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
        const message = error instanceof Error ? error.message : "unknown error";
        console.warn(`Could not grant drizzle journal read access: ${message}`);
      }
    },
  };
}

function postgresErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}
