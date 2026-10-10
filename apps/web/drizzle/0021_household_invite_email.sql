-- PEN-209: invites name one email address and carry a hashed, single-use token.
-- Shared invite codes are retired. Any code still open is removed here because
-- it was not bound to an email; owners send a new email invite instead.
DELETE FROM "household_invite";--> statement-breakpoint
ALTER TABLE "household_invite" DROP CONSTRAINT "household_invite_code_unique";--> statement-breakpoint
ALTER TABLE "household_invite" ADD COLUMN "email" text NOT NULL;--> statement-breakpoint
ALTER TABLE "household_invite" ADD COLUMN "token_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "household_invite" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "household_invite" ADD COLUMN "accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "household_invite" ADD COLUMN "accepted_by" text;--> statement-breakpoint
ALTER TABLE "household_invite" ADD CONSTRAINT "household_invite_accepted_by_user_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "household_invite_household_idx" ON "household_invite" USING btree ("household_id");--> statement-breakpoint
ALTER TABLE "household_invite" DROP COLUMN "code";--> statement-breakpoint
ALTER TABLE "household_invite" ADD CONSTRAINT "household_invite_token_hash_unique" UNIQUE("token_hash");--> statement-breakpoint
ALTER TABLE "household_invite" ADD CONSTRAINT "household_invite_email_chk" CHECK ("household_invite"."email" = lower("household_invite"."email") and position('@' in "household_invite"."email") > 1);--> statement-breakpoint
ALTER TABLE "household_invite" ADD CONSTRAINT "household_invite_token_hash_chk" CHECK ("household_invite"."token_hash" ~ '^[0-9a-f]{64}$');