CREATE TABLE "csv_import" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"added_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone,
	CONSTRAINT "csv_import_added_count_chk" CHECK ("csv_import"."added_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "csv_import" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "import_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "csv_import" ADD CONSTRAINT "csv_import_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "csv_import_household_created_idx" ON "csv_import" USING btree ("household_id","created_at");--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_import_batch_id_csv_import_id_fk" FOREIGN KEY ("import_batch_id") REFERENCES "public"."csv_import"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transaction_import_batch_idx" ON "transaction" USING btree ("import_batch_id");--> statement-breakpoint
CREATE POLICY "csv_import_all" ON "csv_import" AS PERMISSIVE FOR ALL TO public USING (app_can_access_household("csv_import"."household_id")) WITH CHECK (app_can_access_household("csv_import"."household_id"));