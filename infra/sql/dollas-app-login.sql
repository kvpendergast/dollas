-- dollas_app LOGIN role for the app connection pool (PEN-214).
--
-- Pulumi runs this as the database owner (neondb_owner on Neon) on every
-- `pulumi up` that changes the password. It is safe to run again.
-- Never create this role from the Neon console, CLI, or API: those paths
-- grant neon_superuser, which bypasses row-level security.
--
-- The app_password placeholder below is replaced with a quoted literal
-- before this runs (psql: -v app_password=...).
-- Table grants are not here: app startup re-applies them with the owner
-- login (APP_GRANT_SQL in apps/web/src/db/apply-migrations.ts).

-- Only a superuser may even name SUPERUSER, BYPASSRLS, or REPLICATION in
-- ALTER ROLE, so the safe attributes are set at creation and checked below.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dollas_app') THEN
    CREATE ROLE dollas_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
  END IF;
END
$$;

ALTER ROLE dollas_app WITH LOGIN NOCREATEROLE NOCREATEDB PASSWORD :'app_password';

DO $$
DECLARE
  app pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO app FROM pg_roles WHERE rolname = 'dollas_app';
  IF app.rolsuper OR app.rolbypassrls OR app.rolreplication OR app.rolcreaterole OR app.rolcreatedb THEN
    RAISE EXCEPTION 'dollas_app has a privileged attribute (superuser, bypassrls, replication, createrole, or createdb). Drop it as a superuser and run pulumi up again.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'neon_superuser') THEN
    IF pg_has_role('dollas_app', 'neon_superuser', 'MEMBER') THEN
      RAISE EXCEPTION 'dollas_app is a member of neon_superuser and would bypass row-level security. It was probably created in the Neon console. Drop it there and run pulumi up again.';
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname <> 'dollas_app'
      AND (r.rolsuper OR r.rolbypassrls)
      AND pg_has_role('dollas_app', r.oid, 'MEMBER')
  ) THEN
    RAISE EXCEPTION 'dollas_app is a member of a superuser or BYPASSRLS role. Revoke that membership and run pulumi up again.';
  END IF;
END
$$;
