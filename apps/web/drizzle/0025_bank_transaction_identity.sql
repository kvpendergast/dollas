ALTER TABLE "transaction" ADD COLUMN "bank_provider_id" text;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "bank_account_ref" text;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "bank_transaction_id" text;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "bank_matched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "bank_occurred_on" date;--> statement-breakpoint
ALTER TABLE "transaction" ADD COLUMN "bank_payee" text;--> statement-breakpoint
CREATE INDEX "transaction_household_account_amount_idx" ON "transaction" USING btree ("household_id","account_id","amount_cents");--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_bank_identity_key" UNIQUE("household_id","bank_provider_id","bank_account_ref","bank_transaction_id");--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_bank_identity_chk" CHECK (("transaction"."bank_provider_id" is null and "transaction"."bank_account_ref" is null and "transaction"."bank_transaction_id" is null) or ("transaction"."bank_provider_id" ~ '^[a-z][a-z0-9_-]{0,31}$' and char_length("transaction"."bank_account_ref") between 1 and 200 and char_length("transaction"."bank_transaction_id") between 1 and 200));--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_bank_match_chk" CHECK (("transaction"."bank_matched_at" is null and "transaction"."bank_occurred_on" is null and "transaction"."bank_payee" is null) or "transaction"."bank_transaction_id" is not null);--> statement-breakpoint
ALTER TABLE "transaction" ADD CONSTRAINT "transaction_bank_payee_chk" CHECK ("transaction"."bank_payee" is null or char_length("transaction"."bank_payee") <= 200);