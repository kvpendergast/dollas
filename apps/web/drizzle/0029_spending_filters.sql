CREATE TABLE "saved_filter" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"filter" jsonb NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_filter_name_chk" CHECK (char_length("saved_filter"."name") between 1 and 60)
);
--> statement-breakpoint
ALTER TABLE "saved_filter" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "csv_import" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "created_by_user_id" text;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "categorized_by_user_id" text;--> statement-breakpoint
ALTER TABLE "saved_filter" ADD CONSTRAINT "saved_filter_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_filter" ADD CONSTRAINT "saved_filter_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saved_filter_household_name_key" ON "saved_filter" USING btree ("household_id",lower("name"));--> statement-breakpoint
ALTER TABLE "csv_import" ADD CONSTRAINT "csv_import_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_categorized_by_user_id_user_id_fk" FOREIGN KEY ("categorized_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transaction_household_created_by_idx" ON "transaction" USING btree ("household_id","created_by_user_id");--> statement-breakpoint
CREATE INDEX "transaction_household_categorized_by_idx" ON "transaction" USING btree ("household_id","categorized_by_user_id");--> statement-breakpoint
CREATE INDEX "transaction_split_transaction_idx" ON "transaction_split" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "transaction_split_household_category_idx" ON "transaction_split" USING btree ("household_id","category_id");--> statement-breakpoint
CREATE POLICY "saved_filter_all" ON "saved_filter" AS PERMISSIVE FOR ALL TO public USING (app_can_access_household("saved_filter"."household_id")) WITH CHECK (app_can_access_household("saved_filter"."household_id"));