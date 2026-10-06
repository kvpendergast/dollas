-- Saved CSV mappings are household data. A mapping's account has to belong
-- to the same household. Grant the existing app role access to the new table.
-- This does not create, alter, or re-login dollas_app.
CREATE OR REPLACE FUNCTION assert_csv_mapping_account_household() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ledger_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM ledger_account a
    WHERE a.id = NEW.ledger_account_id
      AND a.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'csv mapping account must belong to the same household';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS csv_mapping_account_household ON csv_column_mapping;
--> statement-breakpoint
CREATE TRIGGER csv_mapping_account_household
BEFORE INSERT OR UPDATE OF ledger_account_id, household_id ON csv_column_mapping
FOR EACH ROW EXECUTE FUNCTION assert_csv_mapping_account_household();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dollas_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON csv_column_mapping TO dollas_app;
  END IF;
END
$$;
