CREATE TABLE "category_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "category_group_household_name_key" UNIQUE("household_id","name")
);
--> statement-breakpoint
ALTER TABLE "category_group" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "category" DROP CONSTRAINT "category_kind_chk";--> statement-breakpoint
ALTER TABLE "category" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "category_group" ADD CONSTRAINT "category_group_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "category_group_household_idx" ON "category_group" USING btree ("household_id");--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_group_id_category_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."category_group"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "category_group_idx" ON "category" USING btree ("group_id");--> statement-breakpoint
ALTER TABLE "category" ADD CONSTRAINT "category_kind_chk" CHECK ("category"."kind" in ('income', 'expense', 'transfer'));--> statement-breakpoint
CREATE POLICY "category_group_all" ON "category_group" AS PERMISSIVE FOR ALL TO public USING (app_can_access_household("category_group"."household_id")) WITH CHECK (app_can_access_household("category_group"."household_id"));