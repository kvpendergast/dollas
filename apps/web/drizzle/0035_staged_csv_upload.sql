CREATE TABLE "csv_upload" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"content" text NOT NULL,
	"content_sha256" text NOT NULL,
	"char_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "csv_upload_char_count_chk" CHECK ("csv_upload"."char_count" between 1 and 1000000)
);
--> statement-breakpoint
ALTER TABLE "csv_upload" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "csv_upload" ADD CONSTRAINT "csv_upload_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "csv_upload_household_created_idx" ON "csv_upload" USING btree ("household_id","created_at");--> statement-breakpoint
CREATE POLICY "csv_upload_all" ON "csv_upload" AS PERMISSIVE FOR ALL TO public USING (app_can_access_household("csv_upload"."household_id")) WITH CHECK (app_can_access_household("csv_upload"."household_id"));
--> statement-breakpoint
-- Staged files are immutable: a later step must see exactly the bytes that
-- were staged. Delete (expiry cleanup) is allowed; updates are not.
CREATE OR REPLACE FUNCTION refuse_csv_upload_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'staged csv uploads are immutable';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS csv_upload_immutable ON csv_upload;
--> statement-breakpoint
CREATE TRIGGER csv_upload_immutable
BEFORE UPDATE ON csv_upload
FOR EACH ROW EXECUTE FUNCTION refuse_csv_upload_update();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dollas_app') THEN
    GRANT SELECT, INSERT, DELETE ON csv_upload TO dollas_app;
  END IF;
END
$$;
