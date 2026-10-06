CREATE TABLE "bank_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"connection_id" uuid,
	"provider_id" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"ledger_account_id" uuid NOT NULL,
	"balance_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_account_provider_key" UNIQUE("household_id","provider_id","provider_account_id"),
	CONSTRAINT "bank_account_ledger_key" UNIQUE("ledger_account_id"),
	CONSTRAINT "bank_account_provider_chk" CHECK ("bank_account"."provider_id" ~ '^[a-z][a-z0-9_-]{0,31}$'),
	CONSTRAINT "bank_account_provider_account_chk" CHECK (char_length("bank_account"."provider_account_id") between 1 and 200 and "bank_account"."provider_account_id" !~ '[[:cntrl:]]'),
	CONSTRAINT "bank_account_currency_chk" CHECK ("bank_account"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "bank_account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "bank_connection" ADD COLUMN "transactions_since" date;--> statement-breakpoint
ALTER TABLE "bank_account" ADD CONSTRAINT "bank_account_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_account" ADD CONSTRAINT "bank_account_connection_id_bank_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."bank_connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_account" ADD CONSTRAINT "bank_account_ledger_account_id_ledger_account_id_fk" FOREIGN KEY ("ledger_account_id") REFERENCES "public"."ledger_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_account_household_idx" ON "bank_account" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "bank_account_connection_idx" ON "bank_account" USING btree ("connection_id");--> statement-breakpoint
CREATE POLICY "bank_account_all" ON "bank_account" AS PERMISSIVE FOR ALL TO public USING (app_can_access_household("bank_account"."household_id")) WITH CHECK (app_can_access_household("bank_account"."household_id"));