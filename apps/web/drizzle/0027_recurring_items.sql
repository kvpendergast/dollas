CREATE TABLE "recurring_dismissal" (
	"household_id" uuid NOT NULL,
	"recurring_item_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_dismissal_recurring_item_id_transaction_id_pk" PRIMARY KEY("recurring_item_id","transaction_id")
);
--> statement-breakpoint
ALTER TABLE "recurring_dismissal" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "recurring_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"name" text NOT NULL,
	"payee_match" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"cadence" text NOT NULL,
	"anchor_date" date NOT NULL,
	"day_of_month" integer,
	"second_day_of_month" integer,
	"category_id" uuid,
	"account_id" uuid,
	"tolerance_percent" integer DEFAULT 5 NOT NULL,
	"tolerance_cents" integer DEFAULT 0 NOT NULL,
	"window_days" integer DEFAULT 3 NOT NULL,
	"start_date" date,
	"end_date" date,
	"paused_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_item_name_chk" CHECK (char_length("recurring_item"."name") between 1 and 80),
	CONSTRAINT "recurring_item_payee_match_chk" CHECK (char_length("recurring_item"."payee_match") between 2 and 200),
	CONSTRAINT "recurring_item_amount_chk" CHECK ("recurring_item"."amount_cents" <> 0 and abs("recurring_item"."amount_cents") <= 100000000),
	CONSTRAINT "recurring_item_cadence_chk" CHECK ("recurring_item"."cadence" in ('weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'yearly')),
	CONSTRAINT "recurring_item_day_chk" CHECK ("recurring_item"."day_of_month" is null or "recurring_item"."day_of_month" between 1 and 31),
	CONSTRAINT "recurring_item_second_day_chk" CHECK (("recurring_item"."cadence" = 'semimonthly') = ("recurring_item"."second_day_of_month" is not null) and ("recurring_item"."second_day_of_month" is null or "recurring_item"."second_day_of_month" between 1 and 31)),
	CONSTRAINT "recurring_item_tolerance_chk" CHECK ("recurring_item"."tolerance_percent" between 0 and 50 and "recurring_item"."tolerance_cents" between 0 and 10000000 and "recurring_item"."window_days" between 0 and 10),
	CONSTRAINT "recurring_item_dates_chk" CHECK ("recurring_item"."end_date" is null or "recurring_item"."start_date" is null or "recurring_item"."end_date" >= "recurring_item"."start_date")
);
--> statement-breakpoint
ALTER TABLE "recurring_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "recurring_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"recurring_item_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"occurrence_date" date NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_link_source_chk" CHECK ("recurring_link"."source" in ('auto', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "recurring_link" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recurring_dismissal" ADD CONSTRAINT "recurring_dismissal_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_dismissal" ADD CONSTRAINT "recurring_dismissal_recurring_item_id_recurring_item_id_fk" FOREIGN KEY ("recurring_item_id") REFERENCES "public"."recurring_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_dismissal" ADD CONSTRAINT "recurring_dismissal_transaction_id_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transaction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_item" ADD CONSTRAINT "recurring_item_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_item" ADD CONSTRAINT "recurring_item_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."category"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_item" ADD CONSTRAINT "recurring_item_account_id_ledger_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_account"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_link" ADD CONSTRAINT "recurring_link_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_link" ADD CONSTRAINT "recurring_link_recurring_item_id_recurring_item_id_fk" FOREIGN KEY ("recurring_item_id") REFERENCES "public"."recurring_item"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_link" ADD CONSTRAINT "recurring_link_transaction_id_transaction_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transaction"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurring_dismissal_household_idx" ON "recurring_dismissal" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "recurring_item_household_idx" ON "recurring_item" USING btree ("household_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_link_transaction_key" ON "recurring_link" USING btree ("transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_link_occurrence_key" ON "recurring_link" USING btree ("recurring_item_id","occurrence_date");--> statement-breakpoint
CREATE INDEX "recurring_link_household_idx" ON "recurring_link" USING btree ("household_id");--> statement-breakpoint
CREATE POLICY "recurring_dismissal_all" ON "recurring_dismissal" AS PERMISSIVE FOR ALL TO public USING (app_can_access_household("recurring_dismissal"."household_id")) WITH CHECK (app_can_access_household("recurring_dismissal"."household_id"));--> statement-breakpoint
CREATE POLICY "recurring_item_all" ON "recurring_item" AS PERMISSIVE FOR ALL TO public USING (app_can_access_household("recurring_item"."household_id")) WITH CHECK (app_can_access_household("recurring_item"."household_id"));--> statement-breakpoint
CREATE POLICY "recurring_link_all" ON "recurring_link" AS PERMISSIVE FOR ALL TO public USING (app_can_access_household("recurring_link"."household_id")) WITH CHECK (app_can_access_household("recurring_link"."household_id"));