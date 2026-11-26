-- Require the existing guarded creation and transition RPCs for browser users.
-- Existing clients use those functions and retain reads and admin deletion.
-- No data changes. A rollback needs a reviewed migration restoring only the prior
-- creation and update policies and the corresponding grants.
SET LOCAL lock_timeout = '5s';

REVOKE INSERT, UPDATE, TRUNCATE ON TABLE public.rebate_claims FROM PUBLIC, anon, authenticated;
DROP POLICY IF EXISTS rebate_claims_insert ON public.rebate_claims;
DROP POLICY IF EXISTS rebate_claims_update ON public.rebate_claims;

DO $postflight$
BEGIN
  IF has_table_privilege('anon', 'public.rebate_claims', 'INSERT, UPDATE, TRUNCATE')
    OR has_table_privilege('authenticated', 'public.rebate_claims', 'INSERT, UPDATE, TRUNCATE')
    OR has_any_column_privilege('anon', 'public.rebate_claims', 'INSERT, UPDATE')
    OR has_any_column_privilege('authenticated', 'public.rebate_claims', 'INSERT, UPDATE') THEN
    RAISE EXCEPTION 'REBATE_CLAIM_DIRECT_WRITE_GRANT';
  END IF;

  IF NOT has_table_privilege('authenticated', 'public.rebate_claims', 'SELECT')
    OR NOT has_table_privilege('authenticated', 'public.rebate_claims', 'DELETE')
    OR NOT has_function_privilege('authenticated', 'public.create_rebate_claim(uuid,numeric,bigint,uuid,uuid,uuid,text,text)', 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.transition_rebate_claim(uuid,text,bigint,text,text)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.create_rebate_claim(uuid,numeric,bigint,uuid,uuid,uuid,text,text)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.transition_rebate_claim(uuid,text,bigint,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'REBATE_CLAIM_API_GRANT_MISMATCH';
  END IF;
END
$postflight$;
