-- Bank accounts map a provider account onto a ledger account. The link stays
-- after disconnect so the next sync finds the same ledger account. Grant the
-- existing app role access. This does not create, alter, or re-login dollas_app.
CREATE OR REPLACE FUNCTION assert_bank_account_household() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.connection_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM bank_connection c
    WHERE c.id = NEW.connection_id
      AND c.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'bank account connection must belong to the same household';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM ledger_account a
    WHERE a.id = NEW.ledger_account_id
      AND a.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'bank account ledger account must belong to the same household';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS bank_account_household ON bank_account;
--> statement-breakpoint
CREATE TRIGGER bank_account_household
BEFORE INSERT OR UPDATE OF connection_id, ledger_account_id, household_id ON bank_account
FOR EACH ROW EXECUTE FUNCTION assert_bank_account_household();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dollas_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON bank_account TO dollas_app;
  END IF;
END
$$;
