-- Household access routines. The app role cannot insert membership rows;
-- these security-definer functions are the only way in, and they keep the
-- unverified email/password rule next to the policies.
CREATE OR REPLACE FUNCTION app_user_id() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '');
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_can_access_household(hid uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM household_member m
    JOIN "user" u ON u.id = m.user_id
    WHERE m.household_id = hid
      AND m.user_id = app_user_id()
      AND (
        u.email_verified
        OR EXISTS (
          SELECT 1 FROM account a
          WHERE a.user_id = u.id AND a.provider_id = 'google'
        )
      )
  );
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_household(p_name text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  hid uuid;
  uid text := app_user_id();
BEGIN
  IF uid IS NULL OR NOT EXISTS (
    SELECT 1 FROM "user" u
    WHERE u.id = uid AND (
      u.email_verified
      OR EXISTS (SELECT 1 FROM account a WHERE a.user_id = u.id AND a.provider_id = 'google')
    )
  ) THEN
    RAISE EXCEPTION 'Verify your email before opening household books' USING ERRCODE = '42501';
  END IF;
  IF length(trim(p_name)) < 2 THEN
    RAISE EXCEPTION 'Household name is too short';
  END IF;
  INSERT INTO household (name, created_by) VALUES (trim(p_name), uid) RETURNING id INTO hid;
  INSERT INTO household_member (household_id, user_id, role) VALUES (hid, uid, 'owner');
  RETURN hid;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION accept_invite(p_code text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  uid text := app_user_id();
  hid uuid;
BEGIN
  IF uid IS NULL OR NOT EXISTS (
    SELECT 1 FROM "user" u
    WHERE u.id = uid AND (
      u.email_verified
      OR EXISTS (SELECT 1 FROM account a WHERE a.user_id = u.id AND a.provider_id = 'google')
    )
  ) THEN
    RAISE EXCEPTION 'Verify your email before joining a household' USING ERRCODE = '42501';
  END IF;
  SELECT household_id INTO hid
  FROM household_invite
  WHERE code = upper(trim(p_code)) AND expires_at > now();
  IF hid IS NULL THEN
    RAISE EXCEPTION 'That invite code is not active';
  END IF;
  INSERT INTO household_member (household_id, user_id, role)
  VALUES (hid, uid, 'member')
  ON CONFLICT (household_id, user_id) DO NOTHING;
  RETURN hid;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_invite() RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  uid text := app_user_id();
  hid uuid;
  new_code text;
BEGIN
  SELECT m.household_id INTO hid
  FROM household_member m
  WHERE m.user_id = uid AND app_can_access_household(m.household_id)
  ORDER BY m.created_at
  LIMIT 1;
  IF hid IS NULL THEN
    RAISE EXCEPTION 'You are not a member of a household' USING ERRCODE = '42501';
  END IF;
  new_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  INSERT INTO household_invite (household_id, code, created_by, expires_at)
  VALUES (hid, new_code, uid, now() + interval '30 days');
  RETURN new_code;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION assert_transaction_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  tid uuid;
  total integer;
  parts integer;
  n integer;
BEGIN
  IF TG_TABLE_NAME = 'transaction' THEN
    tid := COALESCE(NEW.id, OLD.id);
  ELSE
    tid := COALESCE(NEW.transaction_id, OLD.transaction_id);
  END IF;
  SELECT amount_cents INTO total FROM transaction WHERE id = tid;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(SUM(amount_cents), 0), COUNT(*) INTO parts, n
  FROM transaction_split WHERE transaction_id = tid;
  IF n = 0 OR parts IS DISTINCT FROM total THEN
    RAISE EXCEPTION 'category splits must add up to the transaction';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS transaction_balanced ON transaction;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER transaction_balanced
AFTER INSERT OR UPDATE ON transaction
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_transaction_balanced();
--> statement-breakpoint
DROP TRIGGER IF EXISTS transaction_split_balanced ON transaction_split;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER transaction_split_balanced
AFTER INSERT OR UPDATE OR DELETE ON transaction_split
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_transaction_balanced();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dollas_app') THEN
    GRANT USAGE ON SCHEMA public TO dollas_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON "user", session, account, verification TO dollas_app;
    GRANT SELECT, UPDATE ON household TO dollas_app;
    GRANT SELECT ON household_member TO dollas_app;
    GRANT SELECT ON household_invite TO dollas_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ledger_account, category, category_budget, transaction, transaction_split TO dollas_app;
    GRANT EXECUTE ON FUNCTION app_user_id() TO dollas_app;
    GRANT EXECUTE ON FUNCTION app_can_access_household(uuid) TO dollas_app;
    GRANT EXECUTE ON FUNCTION create_household(text) TO dollas_app;
    GRANT EXECUTE ON FUNCTION accept_invite(text) TO dollas_app;
    GRANT EXECUTE ON FUNCTION create_invite() TO dollas_app;
  END IF;
END
$$;
