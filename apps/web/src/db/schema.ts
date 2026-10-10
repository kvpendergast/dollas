import { sql, type AnyColumn } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
};

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  ...timestamps,
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  token: text("token").notNull().unique(),
  ...timestamps,
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true, mode: "date" }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true, mode: "date" }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps,
  },
  (table) => [unique("account_provider_account_key").on(table.providerId, table.accountId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  ...timestamps,
});

export const household = pgTable(
  "household",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    currency: text("currency").notNull().default("USD"),
    timezone: text("timezone").notNull().default("UTC"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    pgPolicy("household_select", {
      for: "select",
      using: sql`app_can_access_household(${table.id})`,
    }),
    pgPolicy("household_update", {
      for: "update",
      using: sql`app_can_access_household(${table.id})`,
      withCheck: sql`app_can_access_household(${table.id})`,
    }),
  ],
).enableRLS();

export const householdMember = pgTable(
  "household_member",
  {
    householdId: uuid("household_id")
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.householdId, table.userId] }),
    check("household_member_role_chk", sql`${table.role} in ('owner', 'member')`),
    index("household_member_user_idx").on(table.userId),
    pgPolicy("member_select", {
      for: "select",
      using: sql`app_can_access_household(${table.householdId})`,
    }),
  ],
).enableRLS();

export const householdInvite = pgTable(
  "household_invite",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    /** Invited address, lowercase. Accepting needs a login with this verified email. */
    email: text("email").notNull(),
    /** SHA-256 hex of the link token. The token itself is never stored. */
    tokenHash: text("token_hash").notNull().unique(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" }),
    acceptedBy: text("accepted_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    check("household_invite_email_chk", sql`${table.email} = lower(${table.email}) and position('@' in ${table.email}) > 1`),
    check("household_invite_token_hash_chk", sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    index("household_invite_household_idx").on(table.householdId),
    pgPolicy("invite_select", {
      for: "select",
      using: sql`app_can_access_household(${table.householdId})`,
    }),
  ],
).enableRLS();

export const ledgerAccount = pgTable(
  "ledger_account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").notNull(),
    openingBalanceCents: integer("opening_balance_cents").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    check("ledger_account_type_chk", sql`${table.type} in ('checking', 'savings', 'credit', 'cash')`),
    pgPolicy("ledger_all", {
      for: "all",
      using: sql`app_can_access_household(${table.householdId})`,
      withCheck: sql`app_can_access_household(${table.householdId})`,
    }),
  ],
).enableRLS();

export const categoryGroup = pgTable(
  "category_group",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    unique("category_group_household_name_key").on(table.householdId, table.name),
    index("category_group_household_idx").on(table.householdId),
    pgPolicy("category_group_all", {
      for: "all",
      using: sql`app_can_access_household(${table.householdId})`,
      withCheck: sql`app_can_access_household(${table.householdId})`,
    }),
  ],
).enableRLS();

export const category = pgTable(
  "category",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    groupId: uuid("group_id").references(() => categoryGroup.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    check("category_kind_chk", sql`${table.kind} in ('income', 'expense', 'transfer')`),
    index("category_group_idx").on(table.groupId),
    pgPolicy("category_all", {
      for: "all",
      using: sql`app_can_access_household(${table.householdId})`,
      withCheck: sql`app_can_access_household(${table.householdId})`,
    }),
  ],
).enableRLS();

export const categoryBudget = pgTable(
  "category_budget",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => category.id, { onDelete: "cascade" }),
    year: integer("year").notNull(),
    month: integer("month").notNull(),
    amountCents: integer("amount_cents").notNull(),
  },
  (table) => [
    unique("category_budget_month_key").on(table.categoryId, table.year, table.month),
    check("category_budget_year_chk", sql`${table.year} >= 2000 and ${table.year} <= 2200`),
    check("category_budget_month_chk", sql`${table.month} between 1 and 12`),
    check("category_budget_amount_chk", sql`${table.amountCents} >= 0`),
    pgPolicy("budget_all", {
      for: "all",
      using: sql`app_can_access_household(${table.householdId})`,
      withCheck: sql`app_can_access_household(${table.householdId})`,
    }),
  ],
).enableRLS();

/**
 * One committed CSV import. Undo hard-deletes the transactions that carry this
 * id. A member delete sets transaction.deleted_at instead and keeps the row.
 */
export const csvImport = pgTable(
  "csv_import",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    addedCount: integer("added_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    undoneAt: timestamp("undone_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    check("csv_import_added_count_chk", sql`${table.addedCount} >= 0`),
    index("csv_import_household_created_idx").on(table.householdId, table.createdAt),
    pgPolicy("csv_import_all", {
      for: "all",
      using: sql`app_can_access_household(${table.householdId})`,
      withCheck: sql`app_can_access_household(${table.householdId})`,
    }),
  ],
).enableRLS();

const columnIndex = (name: string, value: AnyColumn) =>
  check(name, sql`${value} is null or (${value} between 0 and 63)`);

/**
 * A remembered CSV column mapping. Header files are keyed by header signature.
 * A no-header file that uses one account is keyed with that account so the
 * next file from the same place can skip the mapper.
 */
export const csvColumnMapping = pgTable(
  "csv_column_mapping",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    headerSignature: text("header_signature").notNull(),
    ledgerAccountId: uuid("ledger_account_id").references(() => ledgerAccount.id, { onDelete: "cascade" }),
    hasHeader: boolean("has_header").notNull(),
    dateColumn: integer("date_column"),
    payeeColumn: integer("payee_column"),
    amountMode: text("amount_mode").notNull(),
    amountColumn: integer("amount_column"),
    debitColumn: integer("debit_column"),
    creditColumn: integer("credit_column"),
    flipSign: boolean("flip_sign").notNull().default(false),
    dateOrder: text("date_order"),
    accountMode: text("account_mode").notNull(),
    accountColumn: integer("account_column"),
    categoryColumn: integer("category_column"),
    notesColumn: integer("notes_column"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    unique("csv_column_mapping_signature_key").on(table.householdId, table.headerSignature),
    index("csv_column_mapping_account_idx").on(table.householdId, table.ledgerAccountId),
    check("csv_column_mapping_signature_chk", sql`char_length(${table.headerSignature}) between 1 and 80`),
    check("csv_column_mapping_amount_mode_chk", sql`${table.amountMode} in ('signed', 'debit_credit')`),
    check("csv_column_mapping_account_mode_chk", sql`${table.accountMode} in ('column', 'fixed')`),
    check(
      "csv_column_mapping_date_order_chk",
      sql`${table.dateOrder} is null or ${table.dateOrder} in ('ymd', 'mdy', 'dmy')`,
    ),
    columnIndex("csv_column_mapping_date_chk", table.dateColumn),
    columnIndex("csv_column_mapping_payee_chk", table.payeeColumn),
    columnIndex("csv_column_mapping_amount_chk", table.amountColumn),
    columnIndex("csv_column_mapping_debit_chk", table.debitColumn),
    columnIndex("csv_column_mapping_credit_chk", table.creditColumn),
    columnIndex("csv_column_mapping_account_col_chk", table.accountColumn),
    columnIndex("csv_column_mapping_category_chk", table.categoryColumn),
    columnIndex("csv_column_mapping_notes_chk", table.notesColumn),
    pgPolicy("csv_column_mapping_all", {
      for: "all",
      using: sql`app_can_access_household(${table.householdId})`,
      withCheck: sql`app_can_access_household(${table.householdId})`,
    }),
  ],
).enableRLS();

export const transaction = pgTable(
  "transaction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => ledgerAccount.id, { onDelete: "cascade" }),
    occurredOn: date("occurred_on").notNull(),
    payee: text("payee").notNull(),
    amountCents: integer("amount_cents").notNull(),
    importFingerprint: text("import_fingerprint"),
    /**
     * Set only on rows this CSV import created. Manual entries and bank sync leave it empty.
     * Undo clears it (instead of deleting) on rows a bank sync has since linked to.
     */
    importBatchId: uuid("import_batch_id").references(() => csvImport.id, { onDelete: "set null" }),
    /** Optional note from a mapped CSV column. Blank notes are stored as null. */
    note: text("note"),
    /** Set when a member deletes the transaction. The row and its import fingerprint stay so CSV import does not recreate it. */
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    /**
     * Bank identity (PEN-203): the provider, the provider's account id, and the
     * provider's transaction id. Set on rows bank sync created and on CSV or
     * manual rows a sync linked to. Unique per household, so a re-sync is a
     * no-op. Kept after a soft delete, so a deleted charge stays deleted.
     */
    bankProviderId: text("bank_provider_id"),
    bankAccountRef: text("bank_account_ref"),
    bankTransactionId: text("bank_transaction_id"),
    /** Set when sync linked the bank charge to a row that already existed (CSV or manual) instead of inserting. */
    bankMatchedAt: timestamp("bank_matched_at", { withTimezone: true, mode: "date" }),
    /** The bank's own date and payee for a linked row, so "Not the same charge" can rebuild the bank copy. */
    bankOccurredOn: date("bank_occurred_on"),
    bankPayee: text("bank_payee"),
  },
  (table) => [
    index("transaction_household_date_idx").on(table.householdId, table.occurredOn),
    index("transaction_import_batch_idx").on(table.importBatchId),
    unique("transaction_import_fingerprint_key").on(table.householdId, table.importFingerprint),
    unique("transaction_bank_identity_key").on(
      table.householdId,
      table.bankProviderId,
      table.bankAccountRef,
      table.bankTransactionId,
    ),
    index("transaction_household_account_amount_idx").on(table.householdId, table.accountId, table.amountCents),
    check(
      "transaction_bank_identity_chk",
      sql`(${table.bankProviderId} is null and ${table.bankAccountRef} is null and ${table.bankTransactionId} is null) or (${table.bankProviderId} ~ '^[a-z][a-z0-9_-]{0,31}$' and char_length(${table.bankAccountRef}) between 1 and 200 and char_length(${table.bankTransactionId}) between 1 and 200)`,
    ),
    check(
      "transaction_bank_match_chk",
      sql`(${table.bankMatchedAt} is null and ${table.bankOccurredOn} is null and ${table.bankPayee} is null) or ${table.bankTransactionId} is not null`,
    ),
    check("transaction_bank_payee_chk", sql`${table.bankPayee} is null or char_length(${table.bankPayee}) <= 200`),
    check("transaction_note_chk", sql`${table.note} is null or char_length(${table.note}) <= 500`),
    pgPolicy("transaction_all", {
      for: "all",
      using: sql`app_can_access_household(${table.householdId})`,
      withCheck: sql`app_can_access_household(${table.householdId})`,
    }),
  ],
).enableRLS();

export const payeeCategoryRule = pgTable(
  "payee_category_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    pattern: text("pattern").notNull(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => category.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    check("payee_category_rule_pattern_chk", sql`char_length(${table.pattern}) between 2 and 200`),
    uniqueIndex("payee_category_rule_pattern_key").on(table.householdId, sql`lower(${table.pattern})`),
    index("payee_category_rule_household_idx").on(table.householdId),
    index("payee_category_rule_category_idx").on(table.categoryId),
    pgPolicy("payee_category_rule_all", {
      for: "all",
      using: sql`app_can_access_household(${table.householdId})`,
      withCheck: sql`app_can_access_household(${table.householdId})`,
    }),
  ],
).enableRLS();

export const bankConnection = pgTable(
  "bank_connection",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    label: text("label").notNull(),
    encryptedAccessToken: text("encrypted_access_token").notNull(),
    keyVersion: integer("key_version").notNull(),
    /** Inclusive civil date of the first sync. Later syncs keep it so the window does not slide backward. */
    transactionsSince: date("transactions_since"),
    /**
     * Opaque Plaid `/transactions/sync` cursor. Null until the first successful
     * Plaid sync. Other providers leave it null. The table already has row-level
     * security and the dollas_app grants from 0009.
     */
    syncCursor: text("sync_cursor"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    check("bank_connection_provider_chk", sql`${table.providerId} ~ '^[a-z][a-z0-9_-]{0,31}$'`),
    check(
      "bank_connection_label_chk",
      sql`char_length(${table.label}) between 1 and 80 and ${table.label} !~ '[[:cntrl:]]'`,
    ),
    check(
      "bank_connection_token_chk",
      sql`${table.encryptedAccessToken} ~ '^v[1-9][0-9]{0,8}[.][A-Za-z0-9_-]{16,}[.][A-Za-z0-9_-]{16,}$'`,
    ),
    check("bank_connection_key_version_chk", sql`${table.keyVersion} >= 1`),
    check(
      "bank_connection_sync_cursor_chk",
      sql`${table.syncCursor} is null or (char_length(${table.syncCursor}) between 1 and 8192 and ${table.syncCursor} !~ '[[:cntrl:]]')`,
    ),
    index("bank_connection_household_idx").on(table.householdId),
    pgPolicy("bank_connection_all", {
      for: "all",
      using: sql`app_can_access_household(${table.householdId})`,
      withCheck: sql`app_can_access_household(${table.householdId})`,
    }),
  ],
).enableRLS();

export const bankAccount = pgTable(
  "bank_account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id").references(() => bankConnection.id, { onDelete: "set null" }),
    providerId: text("provider_id").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    ledgerAccountId: uuid("ledger_account_id")
      .notNull()
      .references(() => ledgerAccount.id, { onDelete: "cascade" }),
    balanceCents: integer("balance_cents").notNull(),
    currency: text("currency").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    unique("bank_account_provider_key").on(table.householdId, table.providerId, table.providerAccountId),
    unique("bank_account_ledger_key").on(table.ledgerAccountId),
    check("bank_account_provider_chk", sql`${table.providerId} ~ '^[a-z][a-z0-9_-]{0,31}$'`),
    check(
      "bank_account_provider_account_chk",
      sql`char_length(${table.providerAccountId}) between 1 and 200 and ${table.providerAccountId} !~ '[[:cntrl:]]'`,
    ),
    check("bank_account_currency_chk", sql`${table.currency} ~ '^[A-Z]{3}$'`),
    index("bank_account_household_idx").on(table.householdId),
    index("bank_account_connection_idx").on(table.connectionId),
    pgPolicy("bank_account_all", {
      for: "all",
      using: sql`app_can_access_household(${table.householdId})`,
      withCheck: sql`app_can_access_household(${table.householdId})`,
    }),
  ],
).enableRLS();

export const transactionSplit = pgTable(
  "transaction_split",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transaction.id, { onDelete: "cascade" }),
    householdId: uuid("household_id")
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => category.id, { onDelete: "restrict" }),
    amountCents: integer("amount_cents").notNull(),
  },
  (table) => [
    check("transaction_split_amount_chk", sql`${table.amountCents} <> 0`),
    pgPolicy("split_all", {
      for: "all",
      using: sql`app_can_access_household(${table.householdId})`,
      withCheck: sql`app_can_access_household(${table.householdId})`,
    }),
  ],
).enableRLS();

/*
 * OAuth authorization server tables for agent (MCP) access, owned by the
 * @better-auth/oauth-provider plugin. Like session and account, the plugin
 * reads and writes them through the Better Auth adapter before any household
 * is known, so they are not household-RLS tables. dollas_app gets plain DML
 * and nothing else. App code that lists or revokes connections always filters
 * by the signed-in member (see slices/agents/connections.ts).
 * Access and refresh tokens are stored as SHA-256 hashes, never the token.
 */
/**
 * A known bill or paycheck (PEN-206). Schedule math lives in the domain
 * package; matching links transactions through recurring_link. Category and
 * account are optional hints; when the account is set, only that account's
 * transactions match.
 */
export const recurringItem = pgTable(
  "recurring_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    payeeMatch: text("payee_match").notNull(),
    /** Signed: negative is a bill, positive is income. */
    amountCents: integer("amount_cents").notNull(),
    cadence: text("cadence").notNull(),
    anchorDate: date("anchor_date", { mode: "string" }).notNull(),
    dayOfMonth: integer("day_of_month"),
    secondDayOfMonth: integer("second_day_of_month"),
    categoryId: uuid("category_id").references(() => category.id, { onDelete: "set null" }),
    accountId: uuid("account_id").references(() => ledgerAccount.id, { onDelete: "set null" }),
    tolerancePercent: integer("tolerance_percent").notNull().default(5),
    toleranceCents: integer("tolerance_cents").notNull().default(0),
    windowDays: integer("window_days").notNull().default(3),
    /** Null: no lower bound (backfill still looks back only 180 days). */
    startDate: date("start_date", { mode: "string" }),
    endDate: date("end_date", { mode: "string" }),
    pausedAt: timestamp("paused_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    check("recurring_item_name_chk", sql`char_length(${table.name}) between 1 and 80`),
    check("recurring_item_payee_match_chk", sql`char_length(${table.payeeMatch}) between 2 and 200`),
    check("recurring_item_amount_chk", sql`${table.amountCents} <> 0 and abs(${table.amountCents}) <= 100000000`),
    check(
      "recurring_item_cadence_chk",
      sql`${table.cadence} in ('weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'yearly')`,
    ),
    check("recurring_item_day_chk", sql`${table.dayOfMonth} is null or ${table.dayOfMonth} between 1 and 31`),
    check(
      "recurring_item_second_day_chk",
      sql`(${table.cadence} = 'semimonthly') = (${table.secondDayOfMonth} is not null) and (${table.secondDayOfMonth} is null or ${table.secondDayOfMonth} between 1 and 31)`,
    ),
    check(
      "recurring_item_tolerance_chk",
      sql`${table.tolerancePercent} between 0 and 50 and ${table.toleranceCents} between 0 and 10000000 and ${table.windowDays} between 0 and 10`,
    ),
    check(
      "recurring_item_dates_chk",
      sql`${table.endDate} is null or ${table.startDate} is null or ${table.endDate} >= ${table.startDate}`,
    ),
    index("recurring_item_household_idx").on(table.householdId),
    pgPolicy("recurring_item_all", {
      for: "all",
      using: sql`app_can_access_household(${table.householdId})`,
      withCheck: sql`app_can_access_household(${table.householdId})`,
    }),
  ],
).enableRLS();

/**
 * One transaction fulfilling one occurrence of a recurring item. A transaction
 * links to at most one item; an occurrence takes at most one transaction.
 */
export const recurringLink = pgTable(
  "recurring_link",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    recurringItemId: uuid("recurring_item_id")
      .notNull()
      .references(() => recurringItem.id, { onDelete: "cascade" }),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transaction.id, { onDelete: "cascade" }),
    occurrenceDate: date("occurrence_date", { mode: "string" }).notNull(),
    /** auto: matching linked it; manual: a member did. */
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    check("recurring_link_source_chk", sql`${table.source} in ('auto', 'manual')`),
    uniqueIndex("recurring_link_transaction_key").on(table.transactionId),
    uniqueIndex("recurring_link_occurrence_key").on(table.recurringItemId, table.occurrenceDate),
    index("recurring_link_household_idx").on(table.householdId),
    pgPolicy("recurring_link_all", {
      for: "all",
      using: sql`app_can_access_household(${table.householdId})`,
      withCheck: sql`app_can_access_household(${table.householdId})`,
    }),
  ],
).enableRLS();

/** A member unlinked this transaction from this item; matching never relinks the pair. */
export const recurringDismissal = pgTable(
  "recurring_dismissal",
  {
    householdId: uuid("household_id")
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    recurringItemId: uuid("recurring_item_id")
      .notNull()
      .references(() => recurringItem.id, { onDelete: "cascade" }),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transaction.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.recurringItemId, table.transactionId] }),
    index("recurring_dismissal_household_idx").on(table.householdId),
    pgPolicy("recurring_dismissal_all", {
      for: "all",
      using: sql`app_can_access_household(${table.householdId})`,
      withCheck: sql`app_can_access_household(${table.householdId})`,
    }),
  ],
).enableRLS();

export const oauthClient = pgTable("oauth_client", {
  id: text("id").primaryKey(),
  clientId: text("client_id").notNull().unique(),
  clientSecret: text("client_secret"),
  clientDiscoveryId: text("client_discovery_id"),
  disabled: boolean("disabled").default(false),
  skipConsent: boolean("skip_consent"),
  enableEndSession: boolean("enable_end_session"),
  subjectType: text("subject_type"),
  scopes: text("scopes").array(),
  clientCredentialsScopes: text("client_credentials_scopes").array().default(sql`'{}'::text[]`),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }),
  name: text("name"),
  uri: text("uri"),
  icon: text("icon"),
  contacts: text("contacts").array(),
  tos: text("tos"),
  policy: text("policy"),
  softwareId: text("software_id"),
  softwareVersion: text("software_version"),
  softwareStatement: text("software_statement"),
  redirectUris: text("redirect_uris").array().notNull(),
  postLogoutRedirectUris: text("post_logout_redirect_uris").array(),
  backchannelLogoutUri: text("backchannel_logout_uri"),
  backchannelLogoutSessionRequired: boolean("backchannel_logout_session_required"),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
  applicationType: text("application_type"),
  jwks: text("jwks"),
  jwksUri: text("jwks_uri"),
  grantTypes: text("grant_types").array(),
  responseTypes: text("response_types").array(),
  requirePKCE: boolean("require_pkce"),
  dpopBoundAccessTokens: boolean("dpop_bound_access_tokens").default(false),
  referenceId: text("reference_id"),
  metadata: jsonb("metadata"),
}, (table) => [index("oauth_client_user_idx").on(table.userId)]);

export const oauthResource = pgTable("oauth_resource", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull().unique(),
  name: text("name").notNull(),
  accessTokenTtl: integer("access_token_ttl"),
  refreshTokenTtl: integer("refresh_token_ttl"),
  signingAlgorithm: text("signing_algorithm"),
  signingKeyId: text("signing_key_id"),
  allowedScopes: text("allowed_scopes").array(),
  customClaims: jsonb("custom_claims"),
  dpopBoundAccessTokensRequired: boolean("dpop_bound_access_tokens_required").default(false),
  disabled: boolean("disabled").default(false),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }),
  policyVersion: integer("policy_version").default(1),
  metadata: jsonb("metadata"),
});

export const oauthClientResource = pgTable(
  "oauth_client_resource",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    resourceId: text("resource_id")
      .notNull()
      .references(() => oauthResource.identifier, { onDelete: "cascade" }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    uniqueIndex("oauth_client_resource_pair_idx").on(table.clientId, table.resourceId),
    index("oauth_client_resource_resource_idx").on(table.resourceId),
  ],
);

export const oauthRefreshToken = pgTable(
  "oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }),
    revoked: timestamp("revoked", { withTimezone: true, mode: "date" }),
    rotatedAt: timestamp("rotated_at", { withTimezone: true, mode: "date" }),
    rotationReplayResponse: text("rotation_replay_response"),
    rotationReplayExpiresAt: timestamp("rotation_replay_expires_at", { withTimezone: true, mode: "date" }),
    authTime: timestamp("auth_time", { withTimezone: true, mode: "date" }),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (table) => [
    index("oauth_refresh_token_client_idx").on(table.clientId),
    index("oauth_refresh_token_user_idx").on(table.userId),
    index("oauth_refresh_token_session_idx").on(table.sessionId),
    index("oauth_refresh_token_code_idx").on(table.authorizationCodeId),
  ],
);

export const oauthAccessToken = pgTable(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    token: text("token").unique(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    referenceId: text("reference_id"),
    authorizationCodeId: text("authorization_code_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    refreshId: text("refresh_id").references(() => oauthRefreshToken.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }),
    revoked: timestamp("revoked", { withTimezone: true, mode: "date" }),
    confirmation: jsonb("confirmation"),
    scopes: text("scopes").array().notNull(),
  },
  (table) => [
    index("oauth_access_token_client_idx").on(table.clientId),
    index("oauth_access_token_user_idx").on(table.userId),
    index("oauth_access_token_session_idx").on(table.sessionId),
    index("oauth_access_token_code_idx").on(table.authorizationCodeId),
    index("oauth_access_token_refresh_idx").on(table.refreshId),
  ],
);

export const oauthConsent = pgTable(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    /** The household the member connected the agent to. */
    referenceId: text("reference_id"),
    resources: text("resources").array(),
    requestedUserInfoClaims: text("requested_user_info_claims").array(),
    scopes: text("scopes").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    index("oauth_consent_client_idx").on(table.clientId),
    index("oauth_consent_user_idx").on(table.userId),
  ],
);

/** Replay tombstones for private_key_jwt client assertions. */
export const oauthClientAssertion = pgTable("oauth_client_assertion", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
});

/**
 * When a member's agent last called the MCP endpoint. Household data, so it
 * follows household RLS, and a member only sees their own rows.
 */
export const agentActivity = pgTable(
  "agent_activity",
  {
    householdId: uuid("household_id")
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClient.clientId, { onDelete: "cascade" }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.householdId, table.userId, table.clientId] }),
    pgPolicy("agent_activity_own", {
      for: "all",
      using: sql`${table.userId} = app_user_id() and app_can_access_household(${table.householdId})`,
      withCheck: sql`${table.userId} = app_user_id() and app_can_access_household(${table.householdId})`,
    }),
  ],
).enableRLS();

export const schema = {
  user,
  session,
  account,
  verification,
  household,
  householdMember,
  householdInvite,
  ledgerAccount,
  categoryGroup,
  category,
  categoryBudget,
  payeeCategoryRule,
  csvImport,
  csvColumnMapping,
  transaction,
  transactionSplit,
  bankConnection,
  bankAccount,
  oauthClient,
  oauthResource,
  oauthClientResource,
  oauthRefreshToken,
  oauthAccessToken,
  oauthConsent,
  oauthClientAssertion,
  agentActivity,
};
