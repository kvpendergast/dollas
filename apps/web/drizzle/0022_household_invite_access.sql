-- PEN-209: email invites. dollas_app still cannot insert or update
-- household_invite or household_member rows. These security-definer functions
-- are the only way to create, revoke, look up, and accept an invite. Each one
-- stays inside one household and repeats the rules in
-- packages/domain/src/household/invite.ts with the same messages.
-- Accepting needs its own path because the invitee is not a member yet, so
-- row-level security hides the invite and the household from them until then.
-- This does not create, alter, or re-login dollas_app.
DROP FUNCTION IF EXISTS accept_invite(text);
--> statement-breakpoint
DROP FUNCTION IF EXISTS create_invite();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION create_household_invite(
  p_household_id text,
  p_invite_id text,
  p_email text,
  p_token_hash text
) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  uid text := app_user_id();
  hid uuid := p_household_id::uuid;
  addr text := lower(trim(coalesce(p_email, '')));
  expires timestamptz;
BEGIN
  -- One invite change at a time per household, so two clicks cannot open two invites.
  PERFORM 1 FROM household WHERE id = hid FOR UPDATE;
  IF uid IS NULL OR NOT app_can_access_household(hid) OR NOT EXISTS (
    SELECT 1 FROM household_member m
    WHERE m.household_id = hid AND m.user_id = uid AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Only an owner can invite or revoke.' USING ERRCODE = '42501';
  END IF;
  IF length(addr) > 254 OR addr !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'Enter the email address your person signs in with.';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invite token hash must be lowercase sha-256 hex';
  END IF;
  IF EXISTS (
    SELECT 1 FROM household_member m
    JOIN "user" u ON u.id = m.user_id
    WHERE m.household_id = hid AND lower(u.email) = addr
  ) THEN
    RAISE EXCEPTION 'That person is already in these books.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM household_invite i
    WHERE i.household_id = hid AND i.email = addr
      AND i.revoked_at IS NULL AND i.accepted_at IS NULL AND i.expires_at > now()
  ) THEN
    RAISE EXCEPTION 'That email already has an open invite. Copy its link or revoke it first.';
  END IF;
  INSERT INTO household_invite (id, household_id, email, token_hash, created_by, expires_at)
  VALUES (p_invite_id::uuid, hid, addr, p_token_hash, uid, now() + interval '7 days')
  RETURNING expires_at INTO expires;
  RETURN expires;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION revoke_household_invite(p_household_id text, p_invite_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  uid text := app_user_id();
  hid uuid := p_household_id::uuid;
BEGIN
  IF uid IS NULL OR NOT app_can_access_household(hid) OR NOT EXISTS (
    SELECT 1 FROM household_member m
    WHERE m.household_id = hid AND m.user_id = uid AND m.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Only an owner can invite or revoke.' USING ERRCODE = '42501';
  END IF;
  UPDATE household_invite
  SET revoked_at = now()
  WHERE id = p_invite_id::uuid
    AND household_id = hid
    AND revoked_at IS NULL
    AND accepted_at IS NULL
    AND expires_at > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That invite is no longer open.';
  END IF;
END;
$$;
--> statement-breakpoint
-- Lets the accept page explain an invite to someone holding its link before
-- they are a member. Returns nothing for an unknown hash. The link token is
-- 256 bits, so knowing the hash's preimage is the authorization.
CREATE OR REPLACE FUNCTION household_invite_preview(p_token_hash text)
RETURNS TABLE (
  household_id uuid,
  household_name text,
  invited_by text,
  email text,
  state text,
  expires_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
  SELECT
    i.household_id,
    h.name,
    u.name,
    i.email,
    CASE
      WHEN i.revoked_at IS NOT NULL THEN 'revoked'
      WHEN i.accepted_at IS NOT NULL THEN 'used'
      WHEN i.expires_at <= now() THEN 'expired'
      ELSE 'pending'
    END,
    i.expires_at
  FROM household_invite i
  JOIN household h ON h.id = i.household_id
  JOIN "user" u ON u.id = i.created_by
  WHERE p_token_hash ~ '^[0-9a-f]{64}$' AND i.token_hash = p_token_hash;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION accept_household_invite(p_token_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  uid text := app_user_id();
  inv household_invite%ROWTYPE;
  my_email text;
BEGIN
  IF uid IS NULL OR NOT EXISTS (
    SELECT 1 FROM "user" u
    WHERE u.id = uid AND (
      u.email_verified
      OR EXISTS (SELECT 1 FROM account a WHERE a.user_id = u.id AND a.provider_id = 'google')
    )
  ) THEN
    RAISE EXCEPTION 'Verify your email before joining a household.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO inv
  FROM household_invite
  WHERE p_token_hash ~ '^[0-9a-f]{64}$' AND token_hash = p_token_hash
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That invite link is not valid. Ask for a new one.';
  END IF;
  -- A second click by someone already in these books changes nothing.
  IF EXISTS (SELECT 1 FROM household_member WHERE household_id = inv.household_id AND user_id = uid) THEN
    RETURN inv.household_id;
  END IF;
  IF inv.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'This invite was revoked. Ask the owner for a new one.';
  END IF;
  IF inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'This invite was already used. Ask the owner for a new one.';
  END IF;
  IF inv.expires_at <= now() THEN
    RAISE EXCEPTION 'This invite expired. Ask the owner for a new one.';
  END IF;
  SELECT lower(u.email) INTO my_email FROM "user" u WHERE u.id = uid;
  IF my_email IS DISTINCT FROM inv.email THEN
    RAISE EXCEPTION 'This invite is for a different email. Sign in with the address it was sent to.' USING ERRCODE = '42501';
  END IF;
  -- The app opens one household per login. Joining a second would hide one of them.
  IF EXISTS (SELECT 1 FROM household_member WHERE user_id = uid) THEN
    RAISE EXCEPTION 'You already keep books in another household. Leave it in Settings first, then open this link again.';
  END IF;
  INSERT INTO household_member (household_id, user_id, role) VALUES (inv.household_id, uid, 'member');
  UPDATE household_invite SET accepted_at = now(), accepted_by = uid WHERE id = inv.id;
  RETURN inv.household_id;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  REVOKE ALL ON FUNCTION create_household_invite(text, text, text, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION revoke_household_invite(text, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION household_invite_preview(text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION accept_household_invite(text) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dollas_app') THEN
    GRANT EXECUTE ON FUNCTION create_household_invite(text, text, text, text) TO dollas_app;
    GRANT EXECUTE ON FUNCTION revoke_household_invite(text, text) TO dollas_app;
    GRANT EXECUTE ON FUNCTION household_invite_preview(text) TO dollas_app;
    GRANT EXECUTE ON FUNCTION accept_household_invite(text) TO dollas_app;
  END IF;
END
$$;
