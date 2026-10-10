-- PEN-203: move bank identities out of import_fingerprint.
-- Before this, bank sync stored `bank:{provider}:{encodeURIComponent(id)}` in
-- import_fingerprint with no account. SimpleFIN transaction ids are only unique
-- within an account, so the identity is now (household, provider, provider
-- account, provider transaction id) in the bank_* columns from 0025.
-- A legacy row is moved only when its ledger account is linked to a bank_account
-- of the same provider (bank_account_ledger_key makes that link unique). Rows
-- that cannot be tied to an account, or whose id does not decode, keep the
-- legacy fingerprint; the sync planner still treats it as known, so nothing is
-- duplicated. Safe to run twice. No grants change: the columns are on
-- "transaction", which dollas_app already has DML on under household RLS.
CREATE OR REPLACE FUNCTION pg_temp.dollas_uri_decode(input text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  bytes bytea := ''::bytea;
  i integer := 1;
  n integer := length(input);
  c text;
BEGIN
  WHILE i <= n LOOP
    c := substr(input, i, 1);
    IF c = '%' THEN
      bytes := bytes || decode(substr(input, i + 1, 2), 'hex');
      i := i + 3;
    ELSE
      bytes := bytes || convert_to(c, 'UTF8');
      i := i + 1;
    END IF;
  END LOOP;
  RETURN convert_from(bytes, 'UTF8');
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$;
--> statement-breakpoint
WITH legacy AS (
  SELECT
    t.id,
    ba.provider_id,
    ba.provider_account_id,
    pg_temp.dollas_uri_decode(substr(t.import_fingerprint, char_length('bank:' || ba.provider_id || ':') + 1)) AS provider_transaction_id
  FROM "transaction" t
  JOIN bank_account ba
    ON ba.household_id = t.household_id
   AND ba.ledger_account_id = t.account_id
   AND left(t.import_fingerprint, char_length('bank:' || ba.provider_id || ':')) = 'bank:' || ba.provider_id || ':'
  WHERE t.bank_transaction_id IS NULL
    AND t.import_fingerprint IS NOT NULL
)
UPDATE "transaction" t
SET bank_provider_id = legacy.provider_id,
    bank_account_ref = legacy.provider_account_id,
    bank_transaction_id = legacy.provider_transaction_id,
    import_fingerprint = NULL
FROM legacy
WHERE t.id = legacy.id
  AND legacy.provider_transaction_id IS NOT NULL
  AND char_length(legacy.provider_transaction_id) BETWEEN 1 AND 200
  AND legacy.provider_transaction_id !~ '[[:cntrl:]]';
