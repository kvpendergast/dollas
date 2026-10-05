-- Payee rules are household data. A rule's category has to belong to the same
-- household. Grant the existing app role access to the new table. This does
-- not create, alter, or re-login dollas_app.
CREATE OR REPLACE FUNCTION assert_payee_rule_category_household() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM category c
    WHERE c.id = NEW.category_id
      AND c.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'payee rule category must belong to the same household';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS payee_rule_category_household ON payee_category_rule;
--> statement-breakpoint
CREATE TRIGGER payee_rule_category_household
BEFORE INSERT OR UPDATE OF category_id, household_id ON payee_category_rule
FOR EACH ROW EXECUTE FUNCTION assert_payee_rule_category_household();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dollas_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON payee_category_rule TO dollas_app;
  END IF;
END
$$;
