-- PEN-204: onboarding steps complete from real data. Each trigger stamps the
-- household's step the first time it happens, from any write path (web, CSV
-- import, bank sync, MCP), so services do not each have to remember. The
-- stamp function is SECURITY DEFINER so a sync or import never fails on the
-- bookkeeping row; it only sets timestamps on the row of the household that
-- owns the inserted rows, and nobody can call it directly (EXECUTE revoked).
-- Statement-level triggers with transition tables keep a 1,000-row CSV import
-- to one stamp per household.
CREATE OR REPLACE FUNCTION onboarding_mark(hid uuid, step text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  IF hid IS NULL THEN
    RETURN;
  END IF;
  INSERT INTO household_onboarding (household_id) VALUES (hid) ON CONFLICT (household_id) DO NOTHING;
  UPDATE household_onboarding SET
    account_at = CASE WHEN step = 'account' THEN coalesce(account_at, now()) ELSE account_at END,
    categories_at = CASE WHEN step = 'categories' THEN coalesce(categories_at, now()) ELSE categories_at END,
    transactions_at = CASE WHEN step = 'transactions' THEN coalesce(transactions_at, now()) ELSE transactions_at END,
    budget_at = CASE WHEN step = 'budget' THEN coalesce(budget_at, now()) ELSE budget_at END,
    invite_at = CASE WHEN step = 'invite' THEN coalesce(invite_at, now()) ELSE invite_at END,
    recurring_at = CASE WHEN step = 'recurring' THEN coalesce(recurring_at, now()) ELSE recurring_at END,
    updated_at = now()
  WHERE household_id = hid
    AND (CASE step
      WHEN 'account' THEN account_at
      WHEN 'categories' THEN categories_at
      WHEN 'transactions' THEN transactions_at
      WHEN 'budget' THEN budget_at
      WHEN 'invite' THEN invite_at
      WHEN 'recurring' THEN recurring_at
    END) IS NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION onboarding_mark(uuid, text) FROM PUBLIC;
--> statement-breakpoint
-- One trigger function for every table: TG_ARGV[0] is the step. Categories
-- skip the "Uncategorized" fallbacks import and sync create; budgets count
-- once an amount is above zero; a member insert counts as the invite once the
-- household has two members (the partner joined).
CREATE OR REPLACE FUNCTION onboarding_mark_rows() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  hid uuid;
BEGIN
  IF TG_ARGV[0] = 'categories' THEN
    FOR hid IN SELECT DISTINCT household_id FROM new_rows
      WHERE NOT ((kind = 'expense' AND name = 'Uncategorized') OR (kind = 'income' AND name = 'Uncategorized income')) LOOP
      PERFORM onboarding_mark(hid, 'categories');
    END LOOP;
  ELSIF TG_ARGV[0] = 'budget' THEN
    FOR hid IN SELECT DISTINCT household_id FROM new_rows WHERE amount_cents > 0 LOOP
      PERFORM onboarding_mark(hid, 'budget');
    END LOOP;
  ELSIF TG_ARGV[0] = 'member' THEN
    FOR hid IN SELECT DISTINCT n.household_id FROM new_rows n
      WHERE (SELECT count(*) FROM household_member m WHERE m.household_id = n.household_id) >= 2 LOOP
      PERFORM onboarding_mark(hid, 'invite');
    END LOOP;
  ELSE
    FOR hid IN SELECT DISTINCT household_id FROM new_rows LOOP
      PERFORM onboarding_mark(hid, TG_ARGV[0]);
    END LOOP;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION onboarding_mark_rows() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS onboarding_account ON ledger_account;
--> statement-breakpoint
CREATE TRIGGER onboarding_account AFTER INSERT ON ledger_account
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION onboarding_mark_rows('account');
--> statement-breakpoint
DROP TRIGGER IF EXISTS onboarding_categories ON category;
--> statement-breakpoint
CREATE TRIGGER onboarding_categories AFTER INSERT ON category
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION onboarding_mark_rows('categories');
--> statement-breakpoint
DROP TRIGGER IF EXISTS onboarding_transactions ON "transaction";
--> statement-breakpoint
CREATE TRIGGER onboarding_transactions AFTER INSERT ON "transaction"
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION onboarding_mark_rows('transactions');
--> statement-breakpoint
DROP TRIGGER IF EXISTS onboarding_budget_insert ON category_budget;
--> statement-breakpoint
CREATE TRIGGER onboarding_budget_insert AFTER INSERT ON category_budget
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION onboarding_mark_rows('budget');
--> statement-breakpoint
DROP TRIGGER IF EXISTS onboarding_budget_update ON category_budget;
--> statement-breakpoint
CREATE TRIGGER onboarding_budget_update AFTER UPDATE ON category_budget
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION onboarding_mark_rows('budget');
--> statement-breakpoint
DROP TRIGGER IF EXISTS onboarding_invite ON household_invite;
--> statement-breakpoint
CREATE TRIGGER onboarding_invite AFTER INSERT ON household_invite
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION onboarding_mark_rows('invite');
--> statement-breakpoint
DROP TRIGGER IF EXISTS onboarding_member ON household_member;
--> statement-breakpoint
CREATE TRIGGER onboarding_member AFTER INSERT ON household_member
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION onboarding_mark_rows('member');
--> statement-breakpoint
DROP TRIGGER IF EXISTS onboarding_recurring ON recurring_item;
--> statement-breakpoint
CREATE TRIGGER onboarding_recurring AFTER INSERT ON recurring_item
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION onboarding_mark_rows('recurring');
--> statement-breakpoint
-- Backfill households that existed before this migration, stamped with when
-- each step first happened where we know it. A household that already has
-- transactions is past onboarding: it starts dismissed (no new card on Home),
-- and a member can resume the checklist from Settings.
INSERT INTO household_onboarding (household_id, account_at, categories_at, transactions_at, budget_at, invite_at, recurring_at, dismissed_at)
SELECT
  h.id,
  (SELECT min(a.created_at) FROM ledger_account a WHERE a.household_id = h.id),
  (SELECT min(c.created_at) FROM category c WHERE c.household_id = h.id
     AND NOT ((c.kind = 'expense' AND c.name = 'Uncategorized') OR (c.kind = 'income' AND c.name = 'Uncategorized income'))),
  (SELECT min(t.created_at) FROM "transaction" t WHERE t.household_id = h.id),
  CASE WHEN EXISTS (SELECT 1 FROM category_budget b WHERE b.household_id = h.id AND b.amount_cents > 0) THEN now() END,
  CASE
    WHEN (SELECT count(*) FROM household_member m WHERE m.household_id = h.id) >= 2 THEN now()
    ELSE (SELECT min(i.created_at) FROM household_invite i WHERE i.household_id = h.id)
  END,
  (SELECT min(r.created_at) FROM recurring_item r WHERE r.household_id = h.id),
  CASE WHEN EXISTS (SELECT 1 FROM "transaction" t WHERE t.household_id = h.id) THEN now() END
FROM household h
ON CONFLICT (household_id) DO NOTHING;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dollas_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON household_onboarding TO dollas_app;
  END IF;
END
$$;
