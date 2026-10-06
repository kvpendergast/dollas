-- sync_cursor lives on bank_connection, which already has row-level security.
-- Re-grant the existing app role so the new column is covered. This does not
-- create, alter, or re-login dollas_app.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dollas_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON bank_connection TO dollas_app;
  END IF;
END
$$;
