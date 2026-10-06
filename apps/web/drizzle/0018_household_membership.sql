-- Leave, hand off, and delete a household. dollas_app can read membership
-- rows and cannot delete them. These security-definer functions are the
-- only path, and each one keeps the change inside one household.
-- This does not create, alter, or re-login dollas_app.
CREATE OR REPLACE FUNCTION leave_household(p_household_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  uid text := app_user_id();
  hid uuid := p_household_id::uuid;
  my_role text;
  owner_count integer;
BEGIN
  IF uid IS NULL OR NOT EXISTS (
    SELECT 1 FROM "user" u
    WHERE u.id = uid AND (
      u.email_verified
      OR EXISTS (SELECT 1 FROM account a WHERE a.user_id = u.id AND a.provider_id = 'google')
    )
  ) THEN
    RAISE EXCEPTION 'Verify your email before changing household membership' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM household_member WHERE household_id = hid FOR UPDATE;
  SELECT role INTO my_role
  FROM household_member
  WHERE household_id = hid AND user_id = uid;
  IF my_role IS NULL THEN
    RAISE EXCEPTION 'You are not a member of this household' USING ERRCODE = '42501';
  END IF;
  IF my_role = 'owner' THEN
    SELECT count(*) INTO owner_count
    FROM household_member
    WHERE household_id = hid AND role = 'owner';
    IF owner_count <= 1 THEN
      RAISE EXCEPTION 'You are the last owner. Hand ownership to another member, or delete the household, before you leave.';
    END IF;
  END IF;
  DELETE FROM household_member WHERE household_id = hid AND user_id = uid;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION transfer_household_ownership(p_household_id text, p_member_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  uid text := app_user_id();
  hid uuid := p_household_id::uuid;
  my_role text;
  their_role text;
BEGIN
  IF uid IS NULL OR NOT EXISTS (
    SELECT 1 FROM "user" u
    WHERE u.id = uid AND (
      u.email_verified
      OR EXISTS (SELECT 1 FROM account a WHERE a.user_id = u.id AND a.provider_id = 'google')
    )
  ) THEN
    RAISE EXCEPTION 'Verify your email before changing household membership' USING ERRCODE = '42501';
  END IF;
  IF p_member_id IS NULL OR length(trim(p_member_id)) = 0 OR p_member_id = uid THEN
    RAISE EXCEPTION 'Choose another member.';
  END IF;
  PERFORM 1 FROM household_member WHERE household_id = hid FOR UPDATE;
  SELECT role INTO my_role
  FROM household_member
  WHERE household_id = hid AND user_id = uid;
  IF my_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only an owner can hand off the household.' USING ERRCODE = '42501';
  END IF;
  SELECT role INTO their_role
  FROM household_member
  WHERE household_id = hid AND user_id = p_member_id;
  IF their_role IS NULL THEN
    RAISE EXCEPTION 'That person is not in this household.';
  END IF;
  IF their_role = 'owner' THEN
    RAISE EXCEPTION 'That person is already an owner.';
  END IF;
  UPDATE household_member SET "role" = 'owner' WHERE household_id = hid AND user_id = p_member_id;
  UPDATE household_member SET "role" = 'member' WHERE household_id = hid AND user_id = uid;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION delete_household(p_household_id text, p_confirmation text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  uid text := app_user_id();
  hid uuid := p_household_id::uuid;
  house_name text;
  my_role text;
BEGIN
  IF uid IS NULL OR NOT EXISTS (
    SELECT 1 FROM "user" u
    WHERE u.id = uid AND (
      u.email_verified
      OR EXISTS (SELECT 1 FROM account a WHERE a.user_id = u.id AND a.provider_id = 'google')
    )
  ) THEN
    RAISE EXCEPTION 'Verify your email before changing household membership' USING ERRCODE = '42501';
  END IF;
  SELECT name INTO house_name FROM household WHERE id = hid FOR UPDATE;
  IF house_name IS NULL THEN
    RAISE EXCEPTION 'You are not a member of this household' USING ERRCODE = '42501';
  END IF;
  SELECT role INTO my_role
  FROM household_member
  WHERE household_id = hid AND user_id = uid;
  IF my_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only an owner can delete the household.' USING ERRCODE = '42501';
  END IF;
  IF trim(coalesce(p_confirmation, '')) IS DISTINCT FROM trim(house_name) THEN
    RAISE EXCEPTION 'Type the household name exactly to delete it.';
  END IF;
  -- Transactions go before their splits would be checked. Splits cascade
  -- with the transaction. Every delete is limited to this household id.
  DELETE FROM transaction WHERE household_id = hid;
  DELETE FROM payee_category_rule WHERE household_id = hid;
  DELETE FROM category_budget WHERE household_id = hid;
  DELETE FROM category WHERE household_id = hid;
  DELETE FROM category_group WHERE household_id = hid;
  DELETE FROM bank_account WHERE household_id = hid;
  DELETE FROM bank_connection WHERE household_id = hid;
  DELETE FROM ledger_account WHERE household_id = hid;
  DELETE FROM csv_import WHERE household_id = hid;
  DELETE FROM household_invite WHERE household_id = hid;
  DELETE FROM household_member WHERE household_id = hid;
  DELETE FROM household WHERE id = hid;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dollas_app') THEN
    REVOKE ALL ON FUNCTION leave_household(text) FROM PUBLIC;
    REVOKE ALL ON FUNCTION transfer_household_ownership(text, text) FROM PUBLIC;
    REVOKE ALL ON FUNCTION delete_household(text, text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION leave_household(text) TO dollas_app;
    GRANT EXECUTE ON FUNCTION transfer_household_ownership(text, text) TO dollas_app;
    GRANT EXECUTE ON FUNCTION delete_household(text, text) TO dollas_app;
  END IF;
END
$$;
