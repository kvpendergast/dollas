-- PEN-212: who added and who categorized each transaction, and who ran each CSV
-- import, recorded going forward. Every app write runs inside withActor, which
-- sets app.user_id, so triggers record the member on every write path (manual
-- entry, CSV import, bank sync, "Not the same charge", payee rule apply, and
-- whatever comes later) without each path remembering to. Rows from before this
-- migration, owner scripts, and unattended work stay null ("Unknown"). The
-- functions run as the invoking role (dollas_app) under the same RLS.
CREATE OR REPLACE FUNCTION app_member_or_null() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT u.id FROM "user" u WHERE u.id = app_user_id();
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION set_created_by_member() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.created_by_user_id IS NULL THEN
    NEW.created_by_user_id := app_member_or_null();
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS transaction_created_by ON "transaction";
--> statement-breakpoint
CREATE TRIGGER transaction_created_by
BEFORE INSERT ON "transaction"
FOR EACH ROW EXECUTE FUNCTION set_created_by_member();
--> statement-breakpoint
DROP TRIGGER IF EXISTS csv_import_created_by ON csv_import;
--> statement-breakpoint
CREATE TRIGGER csv_import_created_by
BEFORE INSERT ON csv_import
FOR EACH ROW EXECUTE FUNCTION set_created_by_member();
--> statement-breakpoint
-- New category lines mark their transaction as categorized by the member.
CREATE OR REPLACE FUNCTION mark_categorized_on_split_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  member text := app_member_or_null();
BEGIN
  IF member IS NOT NULL THEN
    UPDATE "transaction" t SET categorized_by_user_id = member
    FROM (SELECT DISTINCT transaction_id FROM inserted_splits) s
    WHERE t.id = s.transaction_id AND t.categorized_by_user_id IS DISTINCT FROM member;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS transaction_split_categorized_insert ON transaction_split;
--> statement-breakpoint
CREATE TRIGGER transaction_split_categorized_insert
AFTER INSERT ON transaction_split
REFERENCING NEW TABLE AS inserted_splits
FOR EACH STATEMENT EXECUTE FUNCTION mark_categorized_on_split_insert();
--> statement-breakpoint
-- A line whose category changes does too; an amount-only change does not.
CREATE OR REPLACE FUNCTION mark_categorized_on_split_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  member text := app_member_or_null();
BEGIN
  IF member IS NOT NULL THEN
    UPDATE "transaction" t SET categorized_by_user_id = member
    FROM (
      SELECT DISTINCT n.transaction_id
      FROM updated_splits n JOIN previous_splits o ON o.id = n.id
      WHERE o.category_id IS DISTINCT FROM n.category_id
    ) s
    WHERE t.id = s.transaction_id AND t.categorized_by_user_id IS DISTINCT FROM member;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS transaction_split_categorized_update ON transaction_split;
--> statement-breakpoint
CREATE TRIGGER transaction_split_categorized_update
AFTER UPDATE ON transaction_split
REFERENCING OLD TABLE AS previous_splits NEW TABLE AS updated_splits
FOR EACH STATEMENT EXECUTE FUNCTION mark_categorized_on_split_update();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dollas_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON saved_filter TO dollas_app;
    GRANT EXECUTE ON FUNCTION app_member_or_null() TO dollas_app;
  END IF;
END
$$;
