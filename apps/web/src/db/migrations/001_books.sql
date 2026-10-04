-- Household books. Money is integer cents. The app role cannot bypass row-level security.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dollas_app') THEN
    CREATE ROLE dollas_app LOGIN PASSWORD 'dollas' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session (
  id text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS account (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, account_id)
);

CREATE TABLE IF NOT EXISTS verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS household (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  timezone text NOT NULL DEFAULT 'UTC',
  created_by text NOT NULL REFERENCES "user" (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS household_member (
  household_id uuid NOT NULL REFERENCES household (id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, user_id)
);

CREATE TABLE IF NOT EXISTS household_invite (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  created_by text NOT NULL REFERENCES "user" (id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ledger_account (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('checking', 'savings', 'credit', 'cash')),
  opening_balance_cents integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS category (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('income', 'expense')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS category_budget (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES category (id) ON DELETE CASCADE,
  year integer NOT NULL CHECK (year >= 2000 AND year <= 2200),
  month integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  UNIQUE (category_id, year, month)
);

CREATE TABLE IF NOT EXISTS transaction (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id uuid NOT NULL REFERENCES household (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES ledger_account (id) ON DELETE CASCADE,
  occurred_on date NOT NULL,
  payee text NOT NULL,
  amount_cents integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transaction_split (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES transaction (id) ON DELETE CASCADE,
  household_id uuid NOT NULL REFERENCES household (id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES category (id) ON DELETE RESTRICT,
  amount_cents integer NOT NULL CHECK (amount_cents <> 0)
);

CREATE INDEX IF NOT EXISTS transaction_household_date_idx
  ON transaction (household_id, occurred_on);

CREATE INDEX IF NOT EXISTS household_member_user_idx
  ON household_member (user_id);

CREATE OR REPLACE FUNCTION app_user_id() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '');
$$;

-- Mirrors the domain rule: Google sign-in counts as a verified email.
-- Email and password cannot see household rows until email_verified is true.
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

DROP TRIGGER IF EXISTS transaction_balanced ON transaction;
CREATE CONSTRAINT TRIGGER transaction_balanced
AFTER INSERT OR UPDATE ON transaction
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_transaction_balanced();

DROP TRIGGER IF EXISTS transaction_split_balanced ON transaction_split;
CREATE CONSTRAINT TRIGGER transaction_split_balanced
AFTER INSERT OR UPDATE OR DELETE ON transaction_split
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION assert_transaction_balanced();

ALTER TABLE household ENABLE ROW LEVEL SECURITY;
ALTER TABLE household_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE household_invite ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE category ENABLE ROW LEVEL SECURITY;
ALTER TABLE category_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_split ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS household_select ON household;
CREATE POLICY household_select ON household
  FOR SELECT USING (app_can_access_household(id));
DROP POLICY IF EXISTS household_update ON household;
CREATE POLICY household_update ON household
  FOR UPDATE USING (app_can_access_household(id))
  WITH CHECK (app_can_access_household(id));

DROP POLICY IF EXISTS member_select ON household_member;
CREATE POLICY member_select ON household_member
  FOR SELECT USING (app_can_access_household(household_id));

DROP POLICY IF EXISTS invite_select ON household_invite;
CREATE POLICY invite_select ON household_invite
  FOR SELECT USING (app_can_access_household(household_id));

DROP POLICY IF EXISTS ledger_all ON ledger_account;
CREATE POLICY ledger_all ON ledger_account
  FOR ALL USING (app_can_access_household(household_id))
  WITH CHECK (app_can_access_household(household_id));

DROP POLICY IF EXISTS category_all ON category;
CREATE POLICY category_all ON category
  FOR ALL USING (app_can_access_household(household_id))
  WITH CHECK (app_can_access_household(household_id));

DROP POLICY IF EXISTS budget_all ON category_budget;
CREATE POLICY budget_all ON category_budget
  FOR ALL USING (app_can_access_household(household_id))
  WITH CHECK (app_can_access_household(household_id));

DROP POLICY IF EXISTS transaction_all ON transaction;
CREATE POLICY transaction_all ON transaction
  FOR ALL USING (app_can_access_household(household_id))
  WITH CHECK (app_can_access_household(household_id));

DROP POLICY IF EXISTS split_all ON transaction_split;
CREATE POLICY split_all ON transaction_split
  FOR ALL USING (app_can_access_household(household_id))
  WITH CHECK (app_can_access_household(household_id));

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
