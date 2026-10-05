CREATE TABLE "bank_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"label" text NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_connection_provider_chk" CHECK ("bank_connection"."provider_id" ~ '^[a-z][a-z0-9_-]{0,31}$'),
	CONSTRAINT "bank_connection_label_chk" CHECK (char_length("bank_connection"."label") between 1 and 80 and "bank_connection"."label" !~ '[[:cntrl:]]'),
	CONSTRAINT "bank_connection_token_chk" CHECK ("bank_connection"."encrypted_access_token" ~ '^v[1-9][0-9]{0,8}[.][A-Za-z0-9_-]{16,}[.][A-Za-z0-9_-]{16,}$'),
	CONSTRAINT "bank_connection_key_version_chk" CHECK ("bank_connection"."key_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "bank_connection" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bank_connection" ADD CONSTRAINT "bank_connection_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_connection_household_idx" ON "bank_connection" USING btree ("household_id");--> statement-breakpoint
CREATE POLICY "bank_connection_all" ON "bank_connection" AS PERMISSIVE FOR ALL TO public USING (app_can_access_household("bank_connection"."household_id")) WITH CHECK (app_can_access_household("bank_connection"."household_id"));