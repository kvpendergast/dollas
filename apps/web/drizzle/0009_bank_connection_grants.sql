-- Bank connections are household data. Grant the existing app role access to
-- the new table. This does not create, alter, or re-login dollas_app.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dollas_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON bank_connection TO dollas_app;
  END IF;
END
$$;
