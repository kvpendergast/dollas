-- Agent (MCP) OAuth access for the existing app role.
-- The oauth_* tables belong to the Better Auth oauth-provider plugin. It reads
-- and writes them through the adapter (as dollas_app) before a household is
-- known, the same way it handles session and account, so they carry no
-- household RLS. dollas_app gets DML only: no TRUNCATE, REFERENCES, or TRIGGER.
-- Tokens are stored as SHA-256 hashes by the plugin.
-- agent_activity is household data with RLS (own rows in a household you can see).
-- This does not create, alter, or re-login dollas_app.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dollas_app') THEN
    REVOKE ALL ON oauth_client, oauth_resource, oauth_client_resource, oauth_refresh_token, oauth_access_token, oauth_consent, oauth_client_assertion, agent_activity FROM dollas_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_client, oauth_resource, oauth_client_resource, oauth_refresh_token, oauth_access_token, oauth_consent, oauth_client_assertion TO dollas_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent_activity TO dollas_app;
  END IF;
END
$$;
--> statement-breakpoint
-- Leaving a household (or losing it) disconnects every agent the member had
-- connected to it: tokens are revoked and the consent is removed. The MCP
-- endpoint also checks membership on each call; this keeps the OAuth state honest.
CREATE OR REPLACE FUNCTION revoke_agent_access_on_member_exit() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE oauth_access_token SET revoked = now()
  WHERE user_id = OLD.user_id AND reference_id = OLD.household_id::text AND revoked IS NULL;
  UPDATE oauth_refresh_token SET revoked = now()
  WHERE user_id = OLD.user_id AND reference_id = OLD.household_id::text AND revoked IS NULL;
  DELETE FROM oauth_consent
  WHERE user_id = OLD.user_id AND reference_id = OLD.household_id::text;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION revoke_agent_access_on_member_exit() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS household_member_agent_exit ON household_member;
--> statement-breakpoint
CREATE TRIGGER household_member_agent_exit
AFTER DELETE ON household_member
FOR EACH ROW EXECUTE FUNCTION revoke_agent_access_on_member_exit();
