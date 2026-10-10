-- PEN-206: recurring items are household data under the same RLS as the rest
-- of the books (policies in 0027). Every reference must stay inside one
-- household: an item's category and account, and a link's or dismissal's item
-- and transaction. Grant the existing app role DML on the new tables. This does
-- not create, alter, or re-login dollas_app.
CREATE OR REPLACE FUNCTION assert_recurring_item_household() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.category_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM category c WHERE c.id = NEW.category_id AND c.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'recurring item category must belong to the same household';
  END IF;
  IF NEW.account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ledger_account a WHERE a.id = NEW.account_id AND a.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'recurring item account must belong to the same household';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS recurring_item_household ON recurring_item;
--> statement-breakpoint
CREATE TRIGGER recurring_item_household
BEFORE INSERT OR UPDATE OF category_id, account_id, household_id ON recurring_item
FOR EACH ROW EXECUTE FUNCTION assert_recurring_item_household();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION assert_recurring_pair_household() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM recurring_item r WHERE r.id = NEW.recurring_item_id AND r.household_id = NEW.household_id
  ) OR NOT EXISTS (
    SELECT 1 FROM "transaction" t WHERE t.id = NEW.transaction_id AND t.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'recurring item and transaction must belong to the same household';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS recurring_link_household ON recurring_link;
--> statement-breakpoint
CREATE TRIGGER recurring_link_household
BEFORE INSERT OR UPDATE OF recurring_item_id, transaction_id, household_id ON recurring_link
FOR EACH ROW EXECUTE FUNCTION assert_recurring_pair_household();
--> statement-breakpoint
DROP TRIGGER IF EXISTS recurring_dismissal_household ON recurring_dismissal;
--> statement-breakpoint
CREATE TRIGGER recurring_dismissal_household
BEFORE INSERT OR UPDATE OF recurring_item_id, transaction_id, household_id ON recurring_dismissal
FOR EACH ROW EXECUTE FUNCTION assert_recurring_pair_household();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dollas_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON recurring_item, recurring_link, recurring_dismissal TO dollas_app;
  END IF;
END
$$;
