CREATE TABLE "transfer_pair" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"line_id" uuid NOT NULL,
	"deposit_id" uuid NOT NULL,
	"prior_categories" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transfer_pair_distinct_chk" CHECK ("transfer_pair"."line_id" <> "transfer_pair"."deposit_id")
);
--> statement-breakpoint
ALTER TABLE "transfer_pair" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transfer_pair" ADD CONSTRAINT "transfer_pair_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_pair" ADD CONSTRAINT "transfer_pair_line_id_transaction_id_fk" FOREIGN KEY ("line_id") REFERENCES "public"."transaction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transfer_pair" ADD CONSTRAINT "transfer_pair_deposit_id_transaction_id_fk" FOREIGN KEY ("deposit_id") REFERENCES "public"."transaction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transfer_pair_line_idx" ON "transfer_pair" USING btree ("line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transfer_pair_deposit_idx" ON "transfer_pair" USING btree ("deposit_id");--> statement-breakpoint
CREATE INDEX "transfer_pair_household_idx" ON "transfer_pair" USING btree ("household_id");--> statement-breakpoint
CREATE POLICY "transfer_pair_all" ON "transfer_pair" AS PERMISSIVE FOR ALL TO public USING (app_can_access_household("transfer_pair"."household_id")) WITH CHECK (app_can_access_household("transfer_pair"."household_id"));--> statement-breakpoint
-- PEN-349: a transfer pair links a paycheck's net-pay line to the real deposit
-- in another account. The line is a line (not a deposit) of an income split
-- with only transfer categories and no deposit of its own; the deposit is an
-- ordinary row (not part of a split) in another account for the opposite
-- amount, in the same household. Checked at commit, like the split group.
CREATE OR REPLACE FUNCTION assert_transfer_pair(pair_line uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  pair record;
  line record;
  deposit record;
  parent_kind text;
  bad integer;
BEGIN
  SELECT id, household_id, line_id, deposit_id INTO pair FROM transfer_pair WHERE line_id = pair_line;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT id, household_id, account_id, amount_cents, split_parent_id, split_line_id
    INTO line FROM transaction WHERE id = pair.line_id;
  SELECT id, household_id, account_id, amount_cents, split_kind, split_parent_id, split_replaced_by
    INTO deposit FROM transaction WHERE id = pair.deposit_id;
  IF line.id IS NULL OR deposit.id IS NULL THEN
    RETURN;
  END IF;
  IF line.household_id <> pair.household_id OR deposit.household_id <> pair.household_id THEN
    RAISE EXCEPTION 'a transfer pair stays in one household';
  END IF;
  IF line.split_parent_id IS NULL OR line.split_line_id IS NOT NULL THEN
    RAISE EXCEPTION 'a transfer pair links a split line';
  END IF;
  SELECT split_kind INTO parent_kind FROM transaction WHERE id = line.split_parent_id;
  IF parent_kind IS DISTINCT FROM 'income' THEN
    RAISE EXCEPTION 'a transfer pair links a paycheck line';
  END IF;
  SELECT COUNT(*) INTO bad FROM transaction_split s JOIN category c ON c.id = s.category_id
    WHERE s.transaction_id = line.id AND c.kind <> 'transfer';
  IF bad > 0 THEN
    RAISE EXCEPTION 'a transfer pair links a transfer line';
  END IF;
  SELECT COUNT(*) INTO bad FROM transaction WHERE split_line_id = line.id;
  IF bad > 0 THEN
    RAISE EXCEPTION 'a linked line has no deposit of its own';
  END IF;
  IF deposit.split_kind IS NOT NULL OR deposit.split_parent_id IS NOT NULL OR deposit.split_replaced_by IS NOT NULL THEN
    RAISE EXCEPTION 'a transfer pair deposit is not part of a split';
  END IF;
  IF deposit.amount_cents <> -line.amount_cents OR deposit.account_id = line.account_id THEN
    RAISE EXCEPTION 'a linked deposit must mirror its line';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION assert_transfer_pair_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_transfer_pair(NEW.line_id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS transfer_pair_valid ON transfer_pair;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER transfer_pair_valid
AFTER INSERT OR UPDATE ON transfer_pair
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_transfer_pair_row();
--> statement-breakpoint
-- A linked row keeps its pair valid: its amount, account and split role.
CREATE OR REPLACE FUNCTION assert_transfer_pair_member() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  found uuid;
BEGIN
  FOR found IN
    SELECT line_id FROM transfer_pair WHERE line_id = NEW.id OR deposit_id = NEW.id
    UNION SELECT line_id FROM transfer_pair WHERE NEW.split_line_id IS NOT NULL AND line_id = NEW.split_line_id
  LOOP
    PERFORM assert_transfer_pair(found);
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS transaction_transfer_pair_update ON transaction;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER transaction_transfer_pair_update
AFTER UPDATE OF amount_cents, account_id, split_kind, split_parent_id, split_line_id, split_replaced_by ON transaction
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_transfer_pair_member();
--> statement-breakpoint
DROP TRIGGER IF EXISTS transaction_transfer_pair_insert ON transaction;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER transaction_transfer_pair_insert
AFTER INSERT ON transaction
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW.split_line_id IS NOT NULL)
EXECUTE FUNCTION assert_transfer_pair_member();
--> statement-breakpoint
-- A line's category lines can change (Edit split); the pair rechecks them.
CREATE OR REPLACE FUNCTION assert_transfer_pair_category() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM assert_transfer_pair(NEW.transaction_id);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS transaction_split_transfer_pair ON transaction_split;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER transaction_split_transfer_pair
AFTER INSERT OR UPDATE ON transaction_split
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_transfer_pair_category();
--> statement-breakpoint
-- Unlinking, however it happens (unlink, unsplit, Edit split, or a deleted
-- line), gives the deposit back the category lines it had before the link,
-- as long as those categories still exist and still add up to the deposit.
CREATE OR REPLACE FUNCTION restore_transfer_pair_deposit() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  deposit record;
  prior_total bigint;
  prior_count integer;
  known_count integer;
BEGIN
  SELECT id, household_id, amount_cents INTO deposit FROM transaction WHERE id = OLD.deposit_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT COUNT(*), COALESCE(SUM((item->>'amountCents')::bigint), 0) INTO prior_count, prior_total
    FROM jsonb_array_elements(OLD.prior_categories) item;
  SELECT COUNT(*) INTO known_count
    FROM jsonb_array_elements(OLD.prior_categories) item
    JOIN category c ON c.id = (item->>'categoryId')::uuid AND c.household_id = deposit.household_id;
  IF prior_count = 0 OR known_count <> prior_count OR prior_total <> deposit.amount_cents THEN
    RETURN NULL;
  END IF;
  DELETE FROM transaction_split WHERE transaction_id = deposit.id;
  INSERT INTO transaction_split (transaction_id, household_id, category_id, amount_cents)
    SELECT deposit.id, deposit.household_id, (item->>'categoryId')::uuid, (item->>'amountCents')::integer
    FROM jsonb_array_elements(OLD.prior_categories) item;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS transfer_pair_restore ON transfer_pair;
--> statement-breakpoint
CREATE TRIGGER transfer_pair_restore
AFTER DELETE ON transfer_pair
FOR EACH ROW EXECUTE FUNCTION restore_transfer_pair_deposit();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dollas_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON transfer_pair TO dollas_app;
  END IF;
END
$$;
