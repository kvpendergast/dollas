ALTER TABLE "category" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "category_budget" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "household" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "household_invite" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "household_member" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ledger_account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transaction" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transaction_split" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "category_all" ON "category" AS PERMISSIVE FOR ALL TO public USING (app_can_access_household("category"."household_id")) WITH CHECK (app_can_access_household("category"."household_id"));--> statement-breakpoint
CREATE POLICY "budget_all" ON "category_budget" AS PERMISSIVE FOR ALL TO public USING (app_can_access_household("category_budget"."household_id")) WITH CHECK (app_can_access_household("category_budget"."household_id"));--> statement-breakpoint
CREATE POLICY "household_select" ON "household" AS PERMISSIVE FOR SELECT TO public USING (app_can_access_household("household"."id"));--> statement-breakpoint
CREATE POLICY "household_update" ON "household" AS PERMISSIVE FOR UPDATE TO public USING (app_can_access_household("household"."id")) WITH CHECK (app_can_access_household("household"."id"));--> statement-breakpoint
CREATE POLICY "invite_select" ON "household_invite" AS PERMISSIVE FOR SELECT TO public USING (app_can_access_household("household_invite"."household_id"));--> statement-breakpoint
CREATE POLICY "member_select" ON "household_member" AS PERMISSIVE FOR SELECT TO public USING (app_can_access_household("household_member"."household_id"));--> statement-breakpoint
CREATE POLICY "ledger_all" ON "ledger_account" AS PERMISSIVE FOR ALL TO public USING (app_can_access_household("ledger_account"."household_id")) WITH CHECK (app_can_access_household("ledger_account"."household_id"));--> statement-breakpoint
CREATE POLICY "transaction_all" ON "transaction" AS PERMISSIVE FOR ALL TO public USING (app_can_access_household("transaction"."household_id")) WITH CHECK (app_can_access_household("transaction"."household_id"));--> statement-breakpoint
CREATE POLICY "split_all" ON "transaction_split" AS PERMISSIVE FOR ALL TO public USING (app_can_access_household("transaction_split"."household_id")) WITH CHECK (app_can_access_household("transaction_split"."household_id"));