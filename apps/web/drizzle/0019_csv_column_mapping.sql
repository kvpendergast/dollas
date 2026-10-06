CREATE TABLE "csv_column_mapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"household_id" uuid NOT NULL,
	"header_signature" text NOT NULL,
	"ledger_account_id" uuid,
	"has_header" boolean NOT NULL,
	"date_column" integer,
	"payee_column" integer,
	"amount_mode" text NOT NULL,
	"amount_column" integer,
	"debit_column" integer,
	"credit_column" integer,
	"flip_sign" boolean DEFAULT false NOT NULL,
	"date_order" text,
	"account_mode" text NOT NULL,
	"account_column" integer,
	"category_column" integer,
	"notes_column" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "csv_column_mapping_signature_key" UNIQUE("household_id","header_signature"),
	CONSTRAINT "csv_column_mapping_signature_chk" CHECK (char_length("csv_column_mapping"."header_signature") between 1 and 80),
	CONSTRAINT "csv_column_mapping_amount_mode_chk" CHECK ("csv_column_mapping"."amount_mode" in ('signed', 'debit_credit')),
	CONSTRAINT "csv_column_mapping_account_mode_chk" CHECK ("csv_column_mapping"."account_mode" in ('column', 'fixed')),
	CONSTRAINT "csv_column_mapping_date_order_chk" CHECK ("csv_column_mapping"."date_order" is null or "csv_column_mapping"."date_order" in ('ymd', 'mdy', 'dmy')),
	CONSTRAINT "csv_column_mapping_date_chk" CHECK ("csv_column_mapping"."date_column" is null or ("csv_column_mapping"."date_column" between 0 and 63)),
	CONSTRAINT "csv_column_mapping_payee_chk" CHECK ("csv_column_mapping"."payee_column" is null or ("csv_column_mapping"."payee_column" between 0 and 63)),
	CONSTRAINT "csv_column_mapping_amount_chk" CHECK ("csv_column_mapping"."amount_column" is null or ("csv_column_mapping"."amount_column" between 0 and 63)),
	CONSTRAINT "csv_column_mapping_debit_chk" CHECK ("csv_column_mapping"."debit_column" is null or ("csv_column_mapping"."debit_column" between 0 and 63)),
	CONSTRAINT "csv_column_mapping_credit_chk" CHECK ("csv_column_mapping"."credit_column" is null or ("csv_column_mapping"."credit_column" between 0 and 63)),
	CONSTRAINT "csv_column_mapping_account_col_chk" CHECK ("csv_column_mapping"."account_column" is null or ("csv_column_mapping"."account_column" between 0 and 63)),
	CONSTRAINT "csv_column_mapping_category_chk" CHECK ("csv_column_mapping"."category_column" is null or ("csv_column_mapping"."category_column" between 0 and 63)),
	CONSTRAINT "csv_column_mapping_notes_chk" CHECK ("csv_column_mapping"."notes_column" is null or ("csv_column_mapping"."notes_column" between 0 and 63))
);
--> statement-breakpoint
ALTER TABLE "csv_column_mapping" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "csv_column_mapping" ADD CONSTRAINT "csv_column_mapping_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "csv_column_mapping" ADD CONSTRAINT "csv_column_mapping_ledger_account_id_ledger_account_id_fk" FOREIGN KEY ("ledger_account_id") REFERENCES "public"."ledger_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "csv_column_mapping_account_idx" ON "csv_column_mapping" USING btree ("household_id","ledger_account_id");--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_note_chk" CHECK ("transaction"."note" is null or char_length("transaction"."note") <= 500);--> statement-breakpoint
CREATE POLICY "csv_column_mapping_all" ON "csv_column_mapping" AS PERMISSIVE FOR ALL TO public USING (app_can_access_household("csv_column_mapping"."household_id")) WITH CHECK (app_can_access_household("csv_column_mapping"."household_id"));