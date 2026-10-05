-- Local development only. The app connects as dollas_app, which cannot bypass row-level security.
-- Production does not use this password. Neon startup creates dollas_app NOLOGIN, and queries assume that role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dollas_app') THEN
    CREATE ROLE dollas_app LOGIN PASSWORD 'dollas' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;
