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

export const category = pgTable(
  "category",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    householdId: uuid("household_id")
      .notNull()
      .references(() => household.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    check("category_kind_chk", sql`${table.kind} in ('income', 'expense')`),
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
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("transaction_household_date_idx").on(table.householdId, table.occurredOn),
    pgPolicy("transaction_all", {
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
  category,
  categoryBudget,
  transaction,
  transactionSplit,
};
