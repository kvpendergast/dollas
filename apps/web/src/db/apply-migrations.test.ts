import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  APP_GRANT_SQL,
  APP_ROLE_SQL,
  applyMigrations,
  legacyBaselineAt,
  migrationFolderCandidates,
  migrationsFolder,
  migrateOnStartup,
  pendingMigrationTags,
  publicErrorText,
  readJournal,
  resolveMigrationsFolder,
  startupDatabaseUrl,
  type JournalEntry,
  type MigrationSession,
} from "./apply-migrations";

class MemorySession implements MigrationSession {
  migrateCalls = 0;
  baselinedAt: number | null = null;
  ensuredRole = false;
  private locked = false;
  private readonly waiters: Array<() => void> = [];
  private lastCreatedAt: number | null;

  constructor(
    private readonly options?: {
      canCreate?: boolean;
      booksPresent?: boolean;
      journalUnreadable?: boolean;
      lastCreatedAt?: number | null;
      delayMs?: number;
      afterMigrateAt?: number;
      roleError?: Error;
    },
  ) {
    this.lastCreatedAt = options?.lastCreatedAt ?? null;
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

  async end(): Promise<void> {}

  async canCreateSchema(): Promise<boolean> {
    return this.options?.canCreate ?? true;
  }

  async booksSchemaPresent(): Promise<boolean> {
    return this.options?.booksPresent ?? false;
  }

  async latestJournalAt(): Promise<number | null | "unreadable"> {
    if (this.options?.journalUnreadable) return "unreadable";
    return this.lastCreatedAt;
  }

  async ensureAppRole(): Promise<void> {
    this.ensuredRole = true;
    if (this.options?.roleError) throw this.options.roleError;
  }

  async baselineLegacy(createdAt: number): Promise<void> {
    this.baselinedAt = createdAt;
    this.lastCreatedAt = createdAt;
  }

  async migrate(): Promise<void> {
    this.migrateCalls += 1;
    if ((this.options?.delayMs ?? 0) > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.options?.delayMs));
    }
    this.lastCreatedAt = this.options?.afterMigrateAt ?? this.lastCreatedAt;
  }

  async grantAppAccess(): Promise<void> {}

  async grantJournalRead(): Promise<void> {}
}

const sampleJournal: JournalEntry[] = [
  { tag: "0000_books", when: 10 },
  { tag: "0001_household_access", when: 20 },
  { tag: "0002_household_rls", when: 30 },
];

describe("startup database URL", () => {
  it("does not require DATABASE_MIGRATE_URL when a database URL is present", async () => {
    const env = { DATABASE_URL: "postgres://db.internal/dollas" };
    assert.equal("DATABASE_MIGRATE_URL" in env, false);
    const urls: string[] = [];
    const session = new MemorySession({ afterMigrateAt: 30 });
    const result = await migrateOnStartup({
      env,
      journal: sampleJournal,
      connect(url) {
        urls.push(url);
        return session;
      },
    });
    assert.deepEqual(urls, ["postgres://db.internal/dollas"]);
    assert.deepEqual(result.applied, ["0000_books", "0001_household_access", "0002_household_rls"]);
    assert.equal(session.ensuredRole, true);
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

describe("pendingMigrationTags", () => {
  it("already migrated is a no-op", () => {
    const journal = readJournal(migrationsFolder());
    const latest = journal.reduce((max, entry) => Math.max(max, entry.when), 0);
    assert.deepEqual(pendingMigrationTags(journal, latest), []);
    assert.deepEqual(pendingMigrationTags(sampleJournal, 30), []);
  });

  it("keeps migrations after the legacy baseline pending", () => {
    const journal = readJournal(migrationsFolder());
    assert.deepEqual(pendingMigrationTags(journal, legacyBaselineAt(journal)), [
      "0003_csv_import",
      "0004_custom_categories",
      "0005_category_group_grants",
      "0006_payee_category_rules",
      "0007_payee_category_rule_grants",
    ]);
  });

  it("applies only migrations newer than the latest journal timestamp", () => {
    assert.deepEqual(pendingMigrationTags(sampleJournal, null), [
      "0000_books",
      "0001_household_access",
      "0002_household_rls",
    ]);
    assert.deepEqual(pendingMigrationTags(sampleJournal, 20), ["0002_household_rls"]);
  });
});

describe("applyMigrations", () => {
  it("already migrated is a no-op", async () => {
    const journal = readJournal(migrationsFolder());
    const latest = journal.reduce((max, entry) => Math.max(max, entry.when), 0);
    const session = new MemorySession({ lastCreatedAt: latest, booksPresent: true });
    const result = await applyMigrations(session, journal, migrationsFolder());
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.skipped, journal.map((entry) => entry.tag));
    assert.equal(session.migrateCalls, 0);
  });

  it("a second start does not apply the migration again", async () => {
    const session = new MemorySession({ afterMigrateAt: 30 });
    const first = await applyMigrations(session, sampleJournal, "drizzle");
    assert.deepEqual(first.applied, ["0000_books", "0001_household_access", "0002_household_rls"]);
    assert.equal(session.migrateCalls, 1);
    const second = await applyMigrations(session, sampleJournal, "drizzle");
    assert.deepEqual(second.applied, []);
    assert.equal(session.migrateCalls, 1);
  });

  it("applies a migration once when two startups overlap", async () => {
    const session = new MemorySession({ delayMs: 30, afterMigrateAt: 30 });
    const [first, second] = await Promise.all([
      applyMigrations(session, sampleJournal, "drizzle"),
      applyMigrations(session, sampleJournal, "drizzle"),
    ]);
    assert.equal(session.migrateCalls, 1);
    const applied = [...first.applied, ...second.applied];
    assert.deepEqual(applied, ["0000_books", "0001_household_access", "0002_household_rls"]);
  });

  it("baselines an existing books schema instead of replaying generated SQL", async () => {
    const session = new MemorySession({ booksPresent: true });
    const result = await applyMigrations(session, sampleJournal, "drizzle");
    assert.equal(session.baselinedAt, 30);
    assert.equal(session.migrateCalls, 0);
    assert.deepEqual(result.applied, []);
  });

  it("is a no-op for the local app role when the Drizzle journal is current", async () => {
    const session = new MemorySession({ canCreate: false, booksPresent: true, lastCreatedAt: 30 });
    const result = await applyMigrations(session, sampleJournal, "drizzle");
    assert.deepEqual(result.applied, []);
    assert.equal(session.migrateCalls, 0);
  });

  it("skips startup for the local app role when the books schema is already present", async () => {
    const session = new MemorySession({ canCreate: false, booksPresent: true, journalUnreadable: true });
    const result = await applyMigrations(session, sampleJournal, "drizzle");
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.skipped, sampleJournal.map((entry) => entry.tag));
    assert.equal(session.migrateCalls, 0);
    assert.equal(session.ensuredRole, false);
  });

  it("fails when the role cannot migrate and the schema is missing", async () => {
    const session = new MemorySession({ canCreate: false, booksPresent: false });
    await assert.rejects(() => applyMigrations(session, sampleJournal, "drizzle"), /books schema is missing/);
  });

  it("still applies the schema when creating the app role is rejected", async () => {
    const session = new MemorySession({
      afterMigrateAt: 30,
      roleError: Object.assign(new Error("password must have at least 60 bits of entropy"), { code: "22023" }),
    });
    const result = await applyMigrations(session, sampleJournal, "drizzle");
    assert.equal(session.migrateCalls, 1);
    assert.deepEqual(result.applied, ["0000_books", "0001_household_access", "0002_household_rls"]);
  });

  it("fails when the journal shows a pending migration the role cannot apply", async () => {
    const session = new MemorySession({ canCreate: false, booksPresent: true, lastCreatedAt: 10 });
    await assert.rejects(
      () => applyMigrations(session, sampleJournal, "drizzle"),
      /Pending migrations \(0001_household_access, 0002_household_rls\)/,
    );
  });
});

describe("generated schema", () => {
  it("keeps household access, integer cents, and the non-owner grants", async () => {
    const folder = migrationsFolder();
    const books = await readFile(path.join(folder, "0000_books.sql"), "utf8");
    const access = await readFile(path.join(folder, "0001_household_access.sql"), "utf8");
    const rls = await readFile(path.join(folder, "0002_household_rls.sql"), "utf8");
    const categories = await readFile(path.join(folder, "0004_custom_categories.sql"), "utf8");
    const grants = await readFile(path.join(folder, "0005_category_group_grants.sql"), "utf8");
    const payeeRules = await readFile(path.join(folder, "0006_payee_category_rules.sql"), "utf8");
    const payeeGrants = await readFile(path.join(folder, "0007_payee_category_rule_grants.sql"), "utf8");

    assert.match(books, /"amount_cents" integer/);
    assert.match(books, /"opening_balance_cents" integer/);
    assert.match(access, /u\.email_verified/);
    assert.match(access, /a\.provider_id = 'google'/);
    assert.match(access, /GRANT SELECT, UPDATE ON household TO dollas_app/);
    assert.match(access, /GRANT SELECT ON household_member TO dollas_app/);
    assert.match(access, /GRANT SELECT ON household_invite TO dollas_app/);
    assert.equal(/GRANT [^;]*INSERT[^;]*ON household TO dollas_app/.test(access), false);
    assert.equal(/GRANT [^;]*INSERT[^;]*ON household_member TO dollas_app/.test(access), false);
    assert.equal(/GRANT [^;]*INSERT[^;]*ON household_invite TO dollas_app/.test(access), false);
    assert.match(rls, /ENABLE ROW LEVEL SECURITY/);
    assert.match(rls, /app_can_access_household/);
    assert.equal(rls.includes('ALTER TABLE "user"'), false);
    assert.equal(rls.includes('ALTER TABLE "session"'), false);
    assert.equal(rls.includes('ALTER TABLE "account"'), false);
    assert.equal(rls.includes('ALTER TABLE "verification"'), false);
    assert.match(APP_ROLE_SQL, /NOLOGIN NOSUPERUSER NOBYPASSRLS/);
    assert.equal(/password/i.test(APP_ROLE_SQL), false);
    assert.match(APP_GRANT_SQL, /GRANT dollas_app TO current_user/);
    assert.match(APP_GRANT_SQL, /REVOKE ALL ON household FROM dollas_app/);
    assert.match(APP_GRANT_SQL, /GRANT SELECT, UPDATE ON household TO dollas_app/);
    assert.match(APP_GRANT_SQL, /REVOKE ALL ON household_member FROM dollas_app/);
    assert.match(APP_GRANT_SQL, /REVOKE ALL ON household_invite FROM dollas_app/);
    assert.equal(/GRANT [^;]*INSERT[^;]*ON household TO dollas_app/.test(APP_GRANT_SQL), false);
    assert.equal(/GRANT [^;]*INSERT[^;]*ON household_member TO dollas_app/.test(APP_GRANT_SQL), false);
    assert.equal(/GRANT [^;]*INSERT[^;]*ON household_invite TO dollas_app/.test(APP_GRANT_SQL), false);
    assert.equal(/password/i.test(APP_GRANT_SQL), false);
    assert.match(APP_GRANT_SQL, /category_group/);
    assert.match(APP_GRANT_SQL, /payee_category_rule/);
    assert.match(categories, /CREATE TABLE "category_group"/);
    assert.match(categories, /'income', 'expense', 'transfer'/);
    assert.match(categories, /ENABLE ROW LEVEL SECURITY/);
    assert.match(categories, /app_can_access_household/);
    assert.equal(categories.includes("dollas_app"), false);
    assert.match(grants, /GRANT SELECT, INSERT, UPDATE, DELETE ON category_group TO dollas_app/);
    assert.match(grants, /category group must belong to the same household/);
    assert.equal(/CREATE ROLE/i.test(grants), false);
    assert.equal(/ALTER ROLE/i.test(grants), false);
    assert.equal(/PASSWORD/i.test(grants), false);
    assert.match(payeeRules, /CREATE TABLE "payee_category_rule"/);
    assert.match(payeeRules, /ENABLE ROW LEVEL SECURITY/);
    assert.match(payeeRules, /app_can_access_household/);
    assert.equal(payeeRules.includes("dollas_app"), false);
    assert.match(payeeGrants, /GRANT SELECT, INSERT, UPDATE, DELETE ON payee_category_rule TO dollas_app/);
    assert.match(payeeGrants, /payee rule category must belong to the same household/);
    assert.equal(/CREATE ROLE/i.test(payeeGrants), false);
    assert.equal(/ALTER ROLE/i.test(payeeGrants), false);
    assert.equal(/PASSWORD/i.test(payeeGrants), false);
    assert.equal(/SET ROLE/i.test(payeeGrants), false);
    assert.equal(/SET LOCAL ROLE/i.test(payeeGrants), false);
  });
});

describe("migration folder lookup", () => {
  it("finds the journal next to the traced server chunk when cwd is the tracing root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "dollas-trace-"));
    const moduleDirectory = path.join(root, "apps", "web", ".next", "server", "chunks");
    mkdirSync(path.join(root, "apps", "web", "drizzle", "meta"), { recursive: true });
    writeFileSync(path.join(root, "apps", "web", "drizzle", "meta", "_journal.json"), "{}");
    const folder = resolveMigrationsFolder(migrationFolderCandidates(root, moduleDirectory));
    assert.equal(folder, path.join(root, "apps", "web", "drizzle"));
  });
});

describe("publicErrorText", () => {
  it("does not include a connection string", () => {
    const error = Object.assign(new Error("connect failed postgres://user:secret@ep.neon.tech/neondb?sslmode=require"), {
      code: "ECONNREFUSED",
    });
    const text = publicErrorText(error);
    assert.match(text, /ECONNREFUSED/);
    assert.equal(text.includes("secret"), false);
    assert.equal(text.includes("ep.neon.tech"), false);
    assert.match(text, /\[redacted-url\]/);
  });
});
