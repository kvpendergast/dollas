-- CSV import batches are household data. A transaction's batch has to belong
-- to the same household. Grant the existing app role access to the new table.
-- This does not create, alter, or re-login dollas_app.
CREATE OR REPLACE FUNCTION assert_import_batch_household() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.import_batch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM csv_import i
    WHERE i.id = NEW.import_batch_id
      AND i.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'import batch must belong to the same household';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS import_batch_household ON transaction;
--> statement-breakpoint
CREATE TRIGGER import_batch_household
BEFORE INSERT OR UPDATE OF import_batch_id, household_id ON transaction
FOR EACH ROW EXECUTE FUNCTION assert_import_batch_household();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dollas_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON csv_import TO dollas_app;
  END IF;
END
$$;
