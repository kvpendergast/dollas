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
      "0008_bank_connection",
      "0009_bank_connection_grants",
      "0010_ledger_account_archive",
      "0011_transaction_deleted_at",
      "0012_bank_account",
      "0013_bank_account_grants",
      "0014_csv_import_batch",
      "0015_csv_import_grants",
      "0016_plaid_sync_cursor",
      "0017_plaid_sync_cursor_grants",
      "0018_household_membership",
      "0019_csv_column_mapping",
      "0020_csv_column_mapping_grants",
      "0021_household_invite_email",
      "0022_household_invite_access",
      "0023_agent_oauth",
      "0024_agent_oauth_access",
      "0025_bank_transaction_identity",
      "0026_bank_identity_backfill",
      "0027_recurring_items",
      "0028_recurring_item_grants",
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
    const bankConnections = await readFile(path.join(folder, "0008_bank_connection.sql"), "utf8");
    const bankGrants = await readFile(path.join(folder, "0009_bank_connection_grants.sql"), "utf8");
    const accountArchive = await readFile(path.join(folder, "0010_ledger_account_archive.sql"), "utf8");
    const transactionDeleted = await readFile(path.join(folder, "0011_transaction_deleted_at.sql"), "utf8");
    const bankAccounts = await readFile(path.join(folder, "0012_bank_account.sql"), "utf8");
    const bankAccountGrants = await readFile(path.join(folder, "0013_bank_account_grants.sql"), "utf8");
    const csvImportBatch = await readFile(path.join(folder, "0014_csv_import_batch.sql"), "utf8");
    const csvImportGrants = await readFile(path.join(folder, "0015_csv_import_grants.sql"), "utf8");
    const plaidCursor = await readFile(path.join(folder, "0016_plaid_sync_cursor.sql"), "utf8");
    const plaidCursorGrants = await readFile(path.join(folder, "0017_plaid_sync_cursor_grants.sql"), "utf8");
    const membership = await readFile(path.join(folder, "0018_household_membership.sql"), "utf8");
    const csvMapping = await readFile(path.join(folder, "0019_csv_column_mapping.sql"), "utf8");
    const csvMappingGrants = await readFile(path.join(folder, "0020_csv_column_mapping_grants.sql"), "utf8");
    const inviteEmail = await readFile(path.join(folder, "0021_household_invite_email.sql"), "utf8");
    const inviteAccess = await readFile(path.join(folder, "0022_household_invite_access.sql"), "utf8");

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
    assert.match(APP_GRANT_SQL, /bank_connection/);
    assert.match(APP_GRANT_SQL, /bank_account/);
    assert.match(APP_GRANT_SQL, /csv_import/);
    assert.match(APP_GRANT_SQL, /csv_column_mapping/);
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
    assert.match(bankConnections, /CREATE TABLE "bank_connection"/);
    assert.match(bankConnections, /encrypted_access_token/);
    assert.match(bankConnections, /ENABLE ROW LEVEL SECURITY/);
    assert.match(bankConnections, /app_can_access_household/);
    assert.equal(bankConnections.includes("dollas_app"), false);
    assert.equal(/password/i.test(bankConnections), false);
    assert.match(bankGrants, /GRANT SELECT, INSERT, UPDATE, DELETE ON bank_connection TO dollas_app/);
    assert.equal(/CREATE ROLE/i.test(bankGrants), false);
    assert.equal(/ALTER ROLE/i.test(bankGrants), false);
    assert.equal(/PASSWORD/i.test(bankGrants), false);
    assert.equal(/SET ROLE/i.test(bankGrants), false);
    assert.equal(/SET LOCAL ROLE/i.test(bankGrants), false);
    assert.match(accountArchive, /ADD COLUMN "archived_at" timestamp with time zone/);
    assert.equal(accountArchive.includes("dollas_app"), false);
    assert.equal(/CREATE ROLE/i.test(accountArchive), false);
    assert.match(transactionDeleted, /ADD COLUMN "deleted_at" timestamp with time zone/);
    assert.equal(transactionDeleted.includes("dollas_app"), false);
    assert.equal(/CREATE ROLE/i.test(transactionDeleted), false);
    assert.equal(/ALTER ROLE/i.test(transactionDeleted), false);
    assert.equal(/PASSWORD/i.test(transactionDeleted), false);
    assert.match(bankAccounts, /CREATE TABLE "bank_account"/);
    assert.match(bankAccounts, /"balance_cents" integer/);
    assert.match(bankAccounts, /ENABLE ROW LEVEL SECURITY/);
    assert.match(bankAccounts, /app_can_access_household/);
    assert.match(bankAccounts, /transactions_since/);
    assert.equal(bankAccounts.includes("dollas_app"), false);
    assert.equal(/CREATE ROLE/i.test(bankAccounts), false);
    assert.equal(/PASSWORD/i.test(bankAccounts), false);
    assert.match(bankAccountGrants, /GRANT SELECT, INSERT, UPDATE, DELETE ON bank_account TO dollas_app/);
    assert.match(bankAccountGrants, /bank account connection must belong to the same household/);
    assert.match(bankAccountGrants, /bank account ledger account must belong to the same household/);
    assert.equal(/CREATE ROLE/i.test(bankAccountGrants), false);
    assert.equal(/ALTER ROLE/i.test(bankAccountGrants), false);
    assert.equal(/PASSWORD/i.test(bankAccountGrants), false);
    assert.equal(/SET ROLE/i.test(bankAccountGrants), false);
    assert.equal(/SET LOCAL ROLE/i.test(bankAccountGrants), false);
    assert.match(csvImportBatch, /CREATE TABLE "csv_import"/);
    assert.match(csvImportBatch, /ENABLE ROW LEVEL SECURITY/);
    assert.match(csvImportBatch, /app_can_access_household/);
    assert.match(csvImportBatch, /ADD COLUMN "import_batch_id" uuid/);
    assert.equal(csvImportBatch.includes("dollas_app"), false);
    assert.equal(/CREATE ROLE/i.test(csvImportBatch), false);
    assert.equal(/ALTER ROLE/i.test(csvImportBatch), false);
    assert.equal(/PASSWORD/i.test(csvImportBatch), false);
    assert.match(csvImportGrants, /GRANT SELECT, INSERT, UPDATE, DELETE ON csv_import TO dollas_app/);
    assert.match(csvImportGrants, /import batch must belong to the same household/);
    assert.equal(/CREATE ROLE/i.test(csvImportGrants), false);
    assert.equal(/ALTER ROLE/i.test(csvImportGrants), false);
    assert.equal(/PASSWORD/i.test(csvImportGrants), false);
    assert.equal(/SET ROLE/i.test(csvImportGrants), false);
    assert.equal(/SET LOCAL ROLE/i.test(csvImportGrants), false);
    assert.match(plaidCursor, /ADD COLUMN "sync_cursor" text/);
    assert.match(plaidCursor, /bank_connection_sync_cursor_chk/);
    assert.equal(plaidCursor.includes("dollas_app"), false);
    assert.equal(/CREATE ROLE/i.test(plaidCursor), false);
    assert.equal(/PASSWORD/i.test(plaidCursor), false);
    assert.match(plaidCursorGrants, /GRANT SELECT, INSERT, UPDATE, DELETE ON bank_connection TO dollas_app/);
    assert.equal(/CREATE ROLE/i.test(plaidCursorGrants), false);
    assert.equal(/ALTER ROLE/i.test(plaidCursorGrants), false);
    assert.equal(/PASSWORD/i.test(plaidCursorGrants), false);
    assert.equal(/SET ROLE/i.test(plaidCursorGrants), false);
    assert.equal(/SET LOCAL ROLE/i.test(plaidCursorGrants), false);
    assert.match(inviteEmail, /DROP COLUMN "code"/);
    assert.match(inviteEmail, /ADD COLUMN "token_hash" text NOT NULL/);
    assert.match(inviteEmail, /household_invite_token_hash_unique/);
    assert.equal(inviteEmail.includes("dollas_app"), false);
    assert.match(inviteAccess, /DROP FUNCTION IF EXISTS accept_invite\(text\)/);
    assert.match(inviteAccess, /CREATE OR REPLACE FUNCTION accept_household_invite\(p_token_hash text\)/);
    assert.match(inviteAccess, /REVOKE ALL ON FUNCTION accept_household_invite\(text\) FROM PUBLIC/);
    assert.match(inviteAccess, /GRANT EXECUTE ON FUNCTION create_household_invite\(text, text, text, text\) TO dollas_app/);
    assert.equal(/GRANT [^;]*(INSERT|UPDATE)[^;]*ON household_invite TO dollas_app/.test(inviteAccess), false);
    assert.equal(/GRANT [^;]*INSERT[^;]*ON household_member TO dollas_app/.test(inviteAccess), false);
    for (const sqlText of [inviteEmail, inviteAccess]) {
      assert.equal(/CREATE ROLE/i.test(sqlText), false);
      assert.equal(/ALTER ROLE/i.test(sqlText), false);
      assert.equal(/PASSWORD/i.test(sqlText), false);
      assert.equal(/SET ROLE/i.test(sqlText), false);
      assert.equal(/SET LOCAL ROLE/i.test(sqlText), false);
    }
    assert.match(APP_GRANT_SQL, /GRANT EXECUTE ON FUNCTION accept_household_invite\(text\) TO dollas_app/);
    assert.equal(APP_GRANT_SQL.includes("accept_invite("), false);
    assert.match(membership, /CREATE OR REPLACE FUNCTION leave_household\(p_household_id text\)/);
    assert.match(membership, /CREATE OR REPLACE FUNCTION transfer_household_ownership\(p_household_id text, p_member_id text\)/);
    assert.match(membership, /CREATE OR REPLACE FUNCTION delete_household\(p_household_id text, p_confirmation text\)/);
    assert.match(membership, /DELETE FROM transaction WHERE household_id = hid/);
    assert.match(membership, /DELETE FROM household WHERE id = hid/);
    assert.match(membership, /GRANT EXECUTE ON FUNCTION leave_household\(text\) TO dollas_app/);
    assert.match(membership, /GRANT EXECUTE ON FUNCTION delete_household\(text, text\) TO dollas_app/);
    assert.equal(/CREATE ROLE/i.test(membership), false);
    assert.equal(/ALTER ROLE/i.test(membership), false);
    assert.equal(/PASSWORD/i.test(membership), false);
    assert.equal(/SET ROLE/i.test(membership), false);
    assert.equal(/SET LOCAL ROLE/i.test(membership), false);
    assert.match(APP_GRANT_SQL, /GRANT EXECUTE ON FUNCTION leave_household\(text\) TO dollas_app/);
    assert.match(APP_GRANT_SQL, /GRANT EXECUTE ON FUNCTION transfer_household_ownership\(text, text\) TO dollas_app/);
    assert.match(APP_GRANT_SQL, /GRANT EXECUTE ON FUNCTION delete_household\(text, text\) TO dollas_app/);
    assert.equal(/CREATE ROLE/i.test(APP_GRANT_SQL), false);
    assert.match(csvMapping, /CREATE TABLE "csv_column_mapping"/);
    assert.match(csvMapping, /ENABLE ROW LEVEL SECURITY/);
    assert.match(csvMapping, /app_can_access_household/);
    assert.match(csvMapping, /ADD COLUMN "note" text/);
    assert.equal(csvMapping.includes("dollas_app"), false);
    assert.equal(/CREATE ROLE/i.test(csvMapping), false);
    assert.equal(/PASSWORD/i.test(csvMapping), false);
    assert.match(csvMappingGrants, /GRANT SELECT, INSERT, UPDATE, DELETE ON csv_column_mapping TO dollas_app/);
    assert.match(csvMappingGrants, /csv mapping account must belong to the same household/);
    assert.equal(/CREATE ROLE/i.test(csvMappingGrants), false);
    assert.equal(/ALTER ROLE/i.test(csvMappingGrants), false);
    assert.equal(/PASSWORD/i.test(csvMappingGrants), false);
    assert.equal(/SET ROLE/i.test(csvMappingGrants), false);
    assert.equal(/SET LOCAL ROLE/i.test(csvMappingGrants), false);
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

  it("does not include a sealed connection token", () => {
    const ciphertext = "v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBB";
    const text = publicErrorText(new Error(`insert failed ${ciphertext}`));
    assert.equal(text.includes(ciphertext), false);
    assert.match(text, /\[redacted-token\]/);
  });
  it("grants dollas_app DML only on agent OAuth tables and keeps agent_activity under household RLS", async () => {
    const folder = migrationsFolder();
    const tables = await readFile(path.join(folder, "0023_agent_oauth.sql"), "utf8");
    const access = await readFile(path.join(folder, "0024_agent_oauth_access.sql"), "utf8");
    assert.match(tables, /ALTER TABLE "agent_activity" ENABLE ROW LEVEL SECURITY/);
    assert.match(tables, /CREATE POLICY "agent_activity_own"/);
    assert.match(tables, /"token" text NOT NULL/);
    for (const sql of [access, APP_GRANT_SQL]) {
      assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_client, oauth_resource, oauth_client_resource, oauth_refresh_token, oauth_access_token, oauth_consent, oauth_client_assertion TO dollas_app/);
      assert.equal(/GRANT [^;]*(TRUNCATE|REFERENCES|TRIGGER|ALL PRIVILEGES)[^;]*ON oauth_/.test(sql), false);
    }
    assert.equal(/CREATE ROLE|ALTER ROLE/.test(access), false);
    assert.match(access, /CREATE TRIGGER household_member_agent_exit/);
    assert.match(access, /REVOKE ALL ON FUNCTION revoke_agent_access_on_member_exit\(\) FROM PUBLIC/);
  });
});
