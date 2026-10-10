CREATE TABLE "household_onboarding" (
	"household_id" uuid PRIMARY KEY NOT NULL,
	"account_at" timestamp with time zone,
	"categories_at" timestamp with time zone,
	"transactions_at" timestamp with time zone,
	"budget_at" timestamp with time zone,
	"invite_at" timestamp with time zone,
	"recurring_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"dismissed_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "household_onboarding" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "household_onboarding" ADD CONSTRAINT "household_onboarding_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_onboarding" ADD CONSTRAINT "household_onboarding_dismissed_by_user_id_user_id_fk" FOREIGN KEY ("dismissed_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "household_onboarding_all" ON "household_onboarding" AS PERMISSIVE FOR ALL TO public USING (app_can_access_household(household_id)) WITH CHECK (app_can_access_household(household_id));