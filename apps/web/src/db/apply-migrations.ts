import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";

/**
 * Session lock shared by every cold start. Direct connections only: PgBouncer
 * transaction pooling would drop it, which is why startup prefers
 * DATABASE_URL_UNPOOLED.
 */
const MIGRATION_LOCK = [4812, 1001] as const;

export type MigrationFile = {
  id: string;
  sql: string;
};

export type MigrationResult = {
  applied: string[];
  skipped: string[];
};

export type MigrationClient = {
  lock(): Promise<void>;
  unlock(): Promise<void>;
  ensureMigrationTable(): Promise<"ok" | "forbidden">;
  appliedIds(): Promise<string[] | "forbidden">;
  execute(statement: string): Promise<void>;
  record(id: string): Promise<"inserted" | "exists">;
  booksSchemaPresent(): Promise<boolean>;
  /** Lets the local app role see which files are applied. Must not throw. */
  grantBookkeepingRead(): Promise<void>;
  end(): Promise<void>;
};

export type MigrateOnStartupOptions = {
  env?: Record<string, string | undefined>;
  files?: MigrationFile[];
  connect?: (url: string) => MigrationClient;
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

async function runStartup(options: MigrateOnStartupOptions): Promise<MigrationResult> {
  const env = options.env ?? process.env;
  const url = startupDatabaseUrl(env);
  const files = options.files ?? (await loadMigrationFiles());
  const connect = options.connect ?? createPostgresMigrationClient;
  const client = connect(url);
  try {
    const result = await applyMigrations(client, files);
    if (result.applied.length > 0) {
      console.log(`Applied schema migrations: ${result.applied.join(", ")}`);
    }
    return result;
  } finally {
    await client.end();
  }
}

export async function applyMigrations(client: MigrationClient, files: MigrationFile[]): Promise<MigrationResult> {
  const ordered = [...files].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  let locked = false;
  try {
    await client.lock();
    locked = true;
    const table = await client.ensureMigrationTable();
    if (table === "forbidden") return await finishWithoutOwnership(client, ordered);
    return await applyPending(client, ordered);
  } finally {
    if (locked) {
      try {
        await client.unlock();
      } catch (error) {
        console.error("Failed to release the schema migration lock", error);
      }
    }
  }
}

async function finishWithoutOwnership(client: MigrationClient, files: MigrationFile[]): Promise<MigrationResult> {
  const known = await client.appliedIds();
  if (known === "forbidden") {
    if (await client.booksSchemaPresent()) {
      console.warn(
        "Skipping startup migrations: this database role cannot change the schema, and the books tables are already present. Local development applies schema changes with pnpm db:migrate.",
      );
      return { applied: [], skipped: files.map((file) => file.id) };
    }
    throw new Error(
      "This database role cannot apply migrations, and the books schema is missing. Startup uses DATABASE_URL_UNPOOLED when set, otherwise DATABASE_URL. Locally, run pnpm db:migrate with DATABASE_MIGRATE_URL.",
    );
  }
  const appliedSet = new Set(known);
  const pending = files.filter((file) => !appliedSet.has(file.id));
  if (pending.length === 0) return { applied: [], skipped: files.map((file) => file.id) };
  throw new Error(
    `Pending migrations (${pending.map((file) => file.id).join(", ")}) cannot be applied by this database role. Locally, run pnpm db:migrate. On Vercel, DATABASE_URL_UNPOOLED or DATABASE_URL must be allowed to change the schema.`,
  );
}

async function applyPending(client: MigrationClient, files: MigrationFile[]): Promise<MigrationResult> {
  const known = await client.appliedIds();
  if (known === "forbidden") return finishWithoutOwnership(client, files);
  const appliedSet = new Set(known);
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    if (appliedSet.has(file.id)) {
      skipped.push(file.id);
      continue;
    }
    for (const statement of splitSqlStatements(file.sql)) {
      if (!isExecutable(statement)) continue;
      await client.execute(statement);
    }
    const recorded = await client.record(file.id);
    appliedSet.add(file.id);
    if (recorded === "inserted") applied.push(file.id);
    else skipped.push(file.id);
  }
  await client.grantBookkeepingRead();
  return { applied, skipped };
}

export async function loadMigrationFiles(directory = migrationsDirectory()): Promise<MigrationFile[]> {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  if (names.length === 0) throw new Error(`No SQL migrations found in ${directory}`);
  const files: MigrationFile[] = [];
  for (const id of names) {
    files.push({ id, sql: await readFile(path.join(directory, id), "utf8") });
  }
  return files;
}

export function migrationsDirectory(): string {
  const besideModule = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
  if (existsSync(path.join(besideModule, "001_books.sql"))) return besideModule;

  const fromApp = path.join(process.cwd(), "src", "db", "migrations");
  if (existsSync(path.join(fromApp, "001_books.sql"))) return fromApp;

  const fromRepo = path.join(process.cwd(), "apps", "web", "src", "db", "migrations");
  if (existsSync(path.join(fromRepo, "001_books.sql"))) return fromRepo;

  throw new Error(
    "Could not find src/db/migrations. Startup schema apply needs the SQL files in the server bundle.",
  );
}

/**
 * psql splits a file into autocommit statements. One simple-query message with
 * every statement would be a single transaction, and CREATE ROLE cannot run there.
 * Dollar quotes keep semicolons inside functions attached to the same statement.
 */
export function splitSqlStatements(source: string): string[] {
  const statements: string[] = [];
  let current = "";
  let index = 0;

  const push = () => {
    const statement = current.trim();
    current = "";
    if (statement.length > 0) statements.push(statement);
  };

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "-" && next === "-") {
      const end = source.indexOf("\n", index);
      const slice = end === -1 ? source.slice(index) : source.slice(index, end + 1);
      current += slice;
      index += slice.length;
      continue;
    }

    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const slice = end === -1 ? source.slice(index) : source.slice(index, end + 2);
      current += slice;
      index += slice.length;
      continue;
    }

    if (char === "'") {
      current += char;
      index += 1;
      while (index < source.length) {
        current += source[index];
        if (source[index] === "'") {
          if (source[index + 1] === "'") {
            current += source[index + 1];
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (char === '"') {
      current += char;
      index += 1;
      while (index < source.length) {
        current += source[index];
        if (source[index] === '"') {
          if (source[index + 1] === '"') {
            current += source[index + 1];
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (char === "$") {
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(source.slice(index));
      if (tag) {
        const closer = source.indexOf(tag[0], index + tag[0].length);
        const slice = closer === -1 ? source.slice(index) : source.slice(index, closer + tag[0].length);
        current += slice;
        index += slice.length;
        continue;
      }
    }

    if (char === ";") {
      current += char;
      index += 1;
      push();
      continue;
    }

    current += char;
    index += 1;
  }

  push();
  return statements;
}

function isExecutable(statement: string): boolean {
  const stripped = statement
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/;/g, " ")
    .trim();
  return stripped.length > 0;
}

export function createPostgresMigrationClient(url: string): MigrationClient {
  const sql = postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: 30,
    connection: { application_name: "dollas-migrate" },
    onnotice() {},
  });

  return {
    async lock() {
      await query(sql, "select pg_advisory_lock($1, $2)", [MIGRATION_LOCK[0], MIGRATION_LOCK[1]]);
    },
    async unlock() {
      await query(sql, "select pg_advisory_unlock($1, $2)", [MIGRATION_LOCK[0], MIGRATION_LOCK[1]]);
    },
    async ensureMigrationTable() {
      try {
        await sql.unsafe(`
          create table if not exists schema_migration (
            id text primary key,
            applied_at timestamptz not null default now()
          )
        `);
        return "ok";
      } catch (error) {
        if (postgresErrorCode(error) === "42501") return "forbidden";
        throw error;
      }
    },
    async appliedIds() {
      try {
        const result = await query(sql, "select id from schema_migration");
        return result.map((row) => String(row.id));
      } catch (error) {
        if (postgresErrorCode(error) === "42501" || postgresErrorCode(error) === "42P01") return "forbidden";
        throw error;
      }
    },
    async execute(statement) {
      await sql.unsafe(statement);
    },
    async record(id) {
      try {
        await query(sql, "insert into schema_migration (id) values ($1)", [id]);
        return "inserted";
      } catch (error) {
        if (postgresErrorCode(error) === "23505") return "exists";
        throw error;
      }
    },
    async booksSchemaPresent() {
      const result = await query(sql, "select to_regclass('public.household') as household");
      return result[0]?.household != null;
    },
    async grantBookkeepingRead() {
      try {
        await sql.unsafe(`
          do $$
          begin
            if exists (select 1 from pg_roles where rolname = 'dollas_app') then
              grant select on schema_migration to dollas_app;
            end if;
          end
          $$;
        `);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        console.warn(`Could not grant schema_migration read access: ${message}`);
      }
    },
    async end() {
      await sql.end({ timeout: 5 });
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

async function query(
  sql: Sql,
  text: string,
  params: Array<string | number> = [],
): Promise<Array<Record<string, unknown>>> {
  const result = await sql.unsafe(text, params);
  return result as unknown as Array<Record<string, unknown>>;
}
