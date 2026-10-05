CREATE TABLE "payee_category_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"pattern" text NOT NULL,
	"category_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payee_category_rule_pattern_chk" CHECK (char_length("payee_category_rule"."pattern") between 2 and 200)
);
--> statement-breakpoint
ALTER TABLE "payee_category_rule" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payee_category_rule" ADD CONSTRAINT "payee_category_rule_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payee_category_rule" ADD CONSTRAINT "payee_category_rule_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payee_category_rule_pattern_key" ON "payee_category_rule" USING btree ("household_id",lower("pattern"));--> statement-breakpoint
CREATE INDEX "payee_category_rule_household_idx" ON "payee_category_rule" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "payee_category_rule_category_idx" ON "payee_category_rule" USING btree ("category_id");--> statement-breakpoint
CREATE POLICY "payee_category_rule_all" ON "payee_category_rule" AS PERMISSIVE FOR ALL TO public USING (app_can_access_household("payee_category_rule"."household_id")) WITH CHECK (app_can_access_household("payee_category_rule"."household_id"));