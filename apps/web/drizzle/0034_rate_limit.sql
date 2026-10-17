CREATE TABLE "rate_limit" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Counters only (hashed keys). Grant the existing app role DML. This does not
-- create, alter, or re-login dollas_app.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dollas_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limit TO dollas_app;
  END IF;
END
$$;
