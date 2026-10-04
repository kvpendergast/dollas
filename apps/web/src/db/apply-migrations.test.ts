import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  applyMigrations,
  loadMigrationFiles,
  migrateOnStartup,
  migrationsDirectory,
  splitSqlStatements,
  startupDatabaseUrl,
  type MigrationClient,
  type MigrationFile,
} from "./apply-migrations";

class MemoryMigrationClient implements MigrationClient {
  readonly executed: string[] = [];
  private readonly applied = new Set<string>();
  private readonly forbidDdl: boolean;
  private readonly readableBookkeeping: boolean;
  private readonly schemaPresent: boolean;
  private readonly executeDelayMs: number;
  private locked = false;
  private readonly waiters: Array<() => void> = [];

  constructor(options?: {
    applied?: string[];
    forbidDdl?: boolean;
    readableBookkeeping?: boolean;
    schemaPresent?: boolean;
    executeDelayMs?: number;
  }) {
    for (const id of options?.applied ?? []) this.applied.add(id);
    this.forbidDdl = options?.forbidDdl ?? false;
    this.readableBookkeeping = options?.readableBookkeeping ?? !this.forbidDdl;
    this.schemaPresent = options?.schemaPresent ?? false;
    this.executeDelayMs = options?.executeDelayMs ?? 0;
  }

  async lock(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async unlock(): Promise<void> {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.locked = false;
  }

  async ensureMigrationTable(): Promise<"ok" | "forbidden"> {
    if (this.forbidDdl) return "forbidden";
    return "ok";
  }

  async appliedIds(): Promise<string[] | "forbidden"> {
    if (!this.readableBookkeeping) return "forbidden";
    return [...this.applied];
  }

  async execute(statement: string): Promise<void> {
    if (this.forbidDdl) throw Object.assign(new Error("permission denied"), { code: "42501" });
    this.executed.push(statement);
    if (this.executeDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.executeDelayMs));
    }
  }

  async record(id: string): Promise<"inserted" | "exists"> {
    if (this.forbidDdl) throw Object.assign(new Error("permission denied"), { code: "42501" });
    if (this.applied.has(id)) return "exists";
    this.applied.add(id);
    return "inserted";
  }

  async booksSchemaPresent(): Promise<boolean> {
    return this.schemaPresent;
  }

  async grantBookkeepingRead(): Promise<void> {}

  async end(): Promise<void> {}
}

const sampleFile: MigrationFile = { id: "001_books.sql", sql: "select 1;" };

describe("startup database URL", () => {
  it("does not require DATABASE_MIGRATE_URL when a database URL is present", async () => {
    const env = { DATABASE_URL: "postgres://db.internal/dollas" };
    assert.equal("DATABASE_MIGRATE_URL" in env, false);
    const urls: string[] = [];
    const client = new MemoryMigrationClient();
    const result = await migrateOnStartup({
      env,
      files: [sampleFile],
      connect(url) {
        urls.push(url);
        return client;
      },
    });
    assert.deepEqual(urls, ["postgres://db.internal/dollas"]);
    assert.deepEqual(result.applied, ["001_books.sql"]);
  });

  it("prefers DATABASE_URL_UNPOOLED over DATABASE_URL and ignores DATABASE_MIGRATE_URL", () => {
    assert.equal(
      startupDatabaseUrl({
        DATABASE_URL: "postgres://pooled.internal/dollas",
        DATABASE_URL_UNPOOLED: "postgres://direct.internal/dollas",
        DATABASE_MIGRATE_URL: "postgres://migrate.internal/dollas",
      }),
      "postgres://direct.internal/dollas",
    );
  });

  it("does not fall back to DATABASE_MIGRATE_URL", () => {
    assert.throws(
      () => startupDatabaseUrl({ DATABASE_MIGRATE_URL: "postgres://migrate.internal/dollas" }),
      /DATABASE_URL is required/,
    );
  });
});

describe("applyMigrations", () => {
  it("already migrated is a no-op", async () => {
    const files = await loadMigrationFiles();
    const client = new MemoryMigrationClient({ applied: files.map((file) => file.id) });
    const result = await applyMigrations(client, files);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.skipped, files.map((file) => file.id));
    assert.equal(client.executed.length, 0);
  });

  it("a second start does not execute the migration again", async () => {
    const files = await loadMigrationFiles();
    const client = new MemoryMigrationClient();
    const first = await applyMigrations(client, files);
    assert.ok(first.applied.includes("001_books.sql"));
    const executed = client.executed.length;
    assert.ok(executed > 1);
    const second = await applyMigrations(client, files);
    assert.deepEqual(second.applied, []);
    assert.ok(second.skipped.includes("001_books.sql"));
    assert.equal(client.executed.length, executed);
  });

  it("applies a migration once when two startups overlap", async () => {
    const client = new MemoryMigrationClient({ executeDelayMs: 30 });
    const [first, second] = await Promise.all([
      applyMigrations(client, [sampleFile]),
      applyMigrations(client, [sampleFile]),
    ]);
    assert.equal(client.executed.length, 1);
    assert.deepEqual([...first.applied, ...second.applied], ["001_books.sql"]);
  });

  it("skips startup for the local app role when the books schema is already present", async () => {
    const client = new MemoryMigrationClient({ forbidDdl: true, schemaPresent: true });
    const result = await applyMigrations(client, [sampleFile]);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.skipped, ["001_books.sql"]);
    assert.equal(client.executed.length, 0);
  });

  it("fails when the role cannot migrate and the schema is missing", async () => {
    const client = new MemoryMigrationClient({ forbidDdl: true, schemaPresent: false });
    await assert.rejects(() => applyMigrations(client, [sampleFile]), /books schema is missing/);
  });

  it("fails when bookkeeping shows a pending migration the role cannot apply", async () => {
    const client = new MemoryMigrationClient({
      forbidDdl: true,
      readableBookkeeping: true,
      applied: [],
    });
    await assert.rejects(() => applyMigrations(client, [sampleFile]), /Pending migrations \(001_books.sql\)/);
  });
});

describe("splitSqlStatements", () => {
  it("keeps household access rules inside the function body", async () => {
    const sql = await readFile(path.join(migrationsDirectory(), "001_books.sql"), "utf8");
    const statements = splitSqlStatements(sql);
    const access = statements.find((statement) =>
      statement.includes("CREATE OR REPLACE FUNCTION app_can_access_household"),
    );
    assert.ok(access);
    assert.match(access, /u\.email_verified/);
    assert.match(access, /a\.provider_id = 'google'/);
    assert.equal(access.includes("CREATE TABLE"), false);

    const role = statements.find((statement) => statement.includes("CREATE ROLE dollas_app"));
    assert.ok(role);
    assert.equal(role.includes("CREATE TABLE"), false);
    assert.equal(
      statements.some((statement) => statement.includes("opening_balance_cents integer")),
      true,
    );
  });

  it("does not split on semicolons inside strings or dollar quotes", () => {
    assert.deepEqual(
      splitSqlStatements("select 'a;b'; select 2;").map((statement) => statement.replace(/\s+/g, " ")),
      ["select 'a;b';", "select 2;"],
    );
    const parts = splitSqlStatements("DO $$\nBEGIN\n  PERFORM 1;\nEND\n$$;\nSELECT 1;");
    assert.equal(parts.length, 2);
    assert.match(parts[0], /PERFORM 1;/);
    assert.equal(parts[1], "SELECT 1;");
  });
});
