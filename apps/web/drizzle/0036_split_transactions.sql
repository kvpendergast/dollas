ALTER TABLE "transaction" ADD COLUMN "split_kind" text;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "split_client_key" text;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "split_parent_id" uuid;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "split_line_id" uuid;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "split_position" integer;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "split_reimbursed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "split_replaced_by" uuid;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_split_parent_fk" FOREIGN KEY ("split_parent_id") REFERENCES "public"."transaction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_split_line_fk" FOREIGN KEY ("split_line_id") REFERENCES "public"."transaction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_split_replaced_by_fk" FOREIGN KEY ("split_replaced_by") REFERENCES "public"."transaction"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transaction_split_parent_idx" ON "transaction" USING btree ("split_parent_id");--> statement-breakpoint
CREATE INDEX "transaction_split_replaced_by_idx" ON "transaction" USING btree ("split_replaced_by");--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_split_client_key_idx" ON "transaction" USING btree ("household_id","split_client_key") WHERE "transaction"."split_client_key" is not null;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_split_kind_chk" CHECK ("transaction"."split_kind" is null or "transaction"."split_kind" in ('income', 'allocation'));--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_split_role_chk" CHECK ("transaction"."split_kind" is null or "transaction"."split_parent_id" is null);--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_split_key_chk" CHECK ("transaction"."split_client_key" is null or ("transaction"."split_kind" is not null and char_length("transaction"."split_client_key") between 1 and 100));--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_split_line_chk" CHECK ("transaction"."split_line_id" is null or "transaction"."split_parent_id" is not null);--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_split_position_chk" CHECK (("transaction"."split_parent_id" is null) = ("transaction"."split_position" is null));--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_split_reimbursed_chk" CHECK (not "transaction"."split_reimbursed" or ("transaction"."split_parent_id" is not null and "transaction"."split_line_id" is null));--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_split_identity_chk" CHECK ("transaction"."split_parent_id" is null or ("transaction"."import_fingerprint" is null and "transaction"."bank_transaction_id" is null and "transaction"."import_batch_id" is null));--> statement-breakpoint
-- PEN-348: a split's lines add up. An income split (a paycheck) has negative
-- lines summing to minus the gross; an allocation split has lines with the
-- parent's sign summing to the parent. A deposit mirrors its net-pay line in
-- another account. Lines share the parent's account, date, household and
-- deleted state. Checked at commit, like transaction_balanced.
CREATE OR REPLACE FUNCTION assert_split_group_for(pid uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  parent record;
  child_count integer;
  line_count integer;
  line_total bigint;
  bad integer;
BEGIN
  SELECT id, household_id, account_id, occurred_on, amount_cents, split_kind, deleted_at
    INTO parent FROM transaction WHERE id = pid;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT COUNT(*) INTO child_count FROM transaction WHERE split_parent_id = pid;
  IF parent.split_kind IS NULL THEN
    IF child_count > 0 THEN
      RAISE EXCEPTION 'split lines need a split parent';
    END IF;
    RETURN;
  END IF;
  SELECT COUNT(*), COALESCE(SUM(amount_cents), 0) INTO line_count, line_total
    FROM transaction WHERE split_parent_id = pid AND split_line_id IS NULL;
  IF line_count = 0 THEN
    RAISE EXCEPTION 'a split needs at least one line';
  END IF;
  SELECT COUNT(*) INTO bad FROM transaction c
    WHERE c.split_parent_id = pid
      AND (c.household_id <> parent.household_id
        OR (c.deleted_at IS NULL) <> (parent.deleted_at IS NULL)
        OR (c.split_line_id IS NULL AND (c.account_id <> parent.account_id OR c.occurred_on <> parent.occurred_on)));
  IF bad > 0 THEN
    RAISE EXCEPTION 'split lines must match their parent';
  END IF;
  IF parent.split_kind = 'income' THEN
    IF parent.amount_cents <= 0 THEN
      RAISE EXCEPTION 'an income split needs a positive parent';
    END IF;
    SELECT COUNT(*) INTO bad FROM transaction
      WHERE split_parent_id = pid AND split_line_id IS NULL AND amount_cents >= 0;
    IF bad > 0 OR line_total <> -parent.amount_cents THEN
      RAISE EXCEPTION 'split lines must add up to the transaction';
    END IF;
  ELSE
    IF parent.amount_cents = 0 THEN
      RAISE EXCEPTION 'a split needs a nonzero parent';
    END IF;
    SELECT COUNT(*) INTO bad FROM transaction
      WHERE split_parent_id = pid AND split_line_id IS NULL AND sign(amount_cents) <> sign(parent.amount_cents);
    IF bad > 0 OR line_total <> parent.amount_cents THEN
      RAISE EXCEPTION 'split lines must add up to the transaction';
    END IF;
  END IF;
  SELECT COUNT(*) INTO bad FROM transaction d
    WHERE d.split_parent_id = pid AND d.split_line_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM transaction l
        WHERE l.id = d.split_line_id AND l.split_parent_id = pid AND l.split_line_id IS NULL
          AND l.amount_cents = -d.amount_cents AND l.account_id <> d.account_id
      );
  IF bad > 0 THEN
    RAISE EXCEPTION 'a split deposit must mirror its line';
  END IF;
  SELECT COUNT(*) INTO bad FROM (
    SELECT split_line_id FROM transaction
    WHERE split_parent_id = pid AND split_line_id IS NOT NULL
    GROUP BY split_line_id HAVING COUNT(*) > 1
  ) twice;
  IF bad > 0 THEN
    RAISE EXCEPTION 'a split line has one deposit at most';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION assert_split_group() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    IF NEW.split_kind IS NOT NULL THEN
      PERFORM assert_split_group_for(NEW.id);
    ELSIF NEW.split_parent_id IS NOT NULL THEN
      PERFORM assert_split_group_for(NEW.split_parent_id);
    END IF;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    IF OLD.split_parent_id IS NOT NULL AND (TG_OP = 'DELETE' OR OLD.split_parent_id IS DISTINCT FROM NEW.split_parent_id) THEN
      PERFORM assert_split_group_for(OLD.split_parent_id);
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.split_kind IS NOT NULL AND NEW.split_kind IS NULL THEN
      PERFORM assert_split_group_for(NEW.id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS transaction_split_group ON transaction;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER transaction_split_group
AFTER INSERT OR UPDATE OR DELETE ON transaction
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_split_group();
--> statement-breakpoint
-- A split row's household matches its parent's, line's and replacement's, so
-- a split never reaches across households even for the owner role.
CREATE OR REPLACE FUNCTION assert_split_same_household() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  other uuid;
BEGIN
  IF NEW.split_parent_id IS NOT NULL THEN
    SELECT household_id INTO other FROM transaction WHERE id = NEW.split_parent_id;
    IF other IS DISTINCT FROM NEW.household_id THEN
      RAISE EXCEPTION 'a split stays in one household';
    END IF;
  END IF;
  IF NEW.split_line_id IS NOT NULL THEN
    SELECT household_id INTO other FROM transaction WHERE id = NEW.split_line_id;
    IF other IS DISTINCT FROM NEW.household_id THEN
      RAISE EXCEPTION 'a split stays in one household';
    END IF;
  END IF;
  IF NEW.split_replaced_by IS NOT NULL THEN
    SELECT household_id INTO other FROM transaction WHERE id = NEW.split_replaced_by;
    IF other IS DISTINCT FROM NEW.household_id THEN
      RAISE EXCEPTION 'a split stays in one household';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS transaction_split_same_household ON transaction;
--> statement-breakpoint
CREATE TRIGGER transaction_split_same_household
BEFORE INSERT OR UPDATE OF split_parent_id, split_line_id, split_replaced_by, household_id ON transaction
FOR EACH ROW EXECUTE FUNCTION assert_split_same_household();
