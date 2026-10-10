-- Local development only. The app connects as dollas_app, which cannot bypass row-level security.
-- Production does not use this password. Pulumi (infra/) creates the production dollas_app login with a
-- generated password and stores it in Vercel as DATABASE_URL_APP.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dollas_app') THEN
    CREATE ROLE dollas_app LOGIN PASSWORD 'dollas' NOSUPERUSER NOBYPASSRLS;
  END IF;
END
$$;
