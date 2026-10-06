import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
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
    code: text("code").notNull().unique(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
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
    /** Set when a member deletes the transaction. The row and its import fingerprint stay so CSV import does not recreate it. */
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("transaction_household_date_idx").on(table.householdId, table.occurredOn),
    unique("transaction_import_fingerprint_key").on(table.householdId, table.importFingerprint),
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
    index("bank_connection_household_idx").on(table.householdId),
    pgPolicy("bank_connection_all", {
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
  transaction,
  transactionSplit,
  bankConnection,
};
