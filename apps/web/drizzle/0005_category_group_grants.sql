-- Category groups are household data. Grant the existing app role access to the
-- new table, and keep a category's group inside the same household. This does
-- not create, alter, or re-login dollas_app.
CREATE OR REPLACE FUNCTION assert_category_group_household() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.group_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM category_group g
    WHERE g.id = NEW.group_id
      AND g.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'category group must belong to the same household';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS category_group_household ON category;
--> statement-breakpoint
CREATE TRIGGER category_group_household
BEFORE INSERT OR UPDATE OF group_id, household_id ON category
FOR EACH ROW EXECUTE FUNCTION assert_category_group_household();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dollas_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON category_group TO dollas_app;
  END IF;
END
$$;
