-- Written 2026-10-23. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migration-history.md (row 981). Stamp and row assigned by the CRX Coordinator
-- session 2026-10-23: lands after #1050 (20261022085000) and #1066 (20261022086000), before #1057
-- (20261022090000). Re-read the live ledger first.
--
-- idempotency-body-check: exempt -- the save_job wrapper delegates to _save_job_cost_step2_impl,
--   which keeps its own idempotency unchanged; the new check is skipped for a key already on file
--   so a replay is answered by the impl exactly as before. The hook only recognises
--   check_idempotency().
--
-- WHAT: PR #1060 follow-up (Mason chose the database check, 2026-10-23). The Job Detail screen
--   now leaves a chemical line's price BLANK when its product states no price (no price for the
--   job customer's tier and no tier-1 price) and refuses the save until one is typed. The browser
--   still turns a blank price into 0 (buildJobChemicalsPayload), so an older app or a direct call
--   could save that line billing $0. save_job now refuses it:
--     CHEM_PRICE_REQUIRED: a line that bills (not customer supplied, quantity not 0) priced at 0
--     whose product states no price for the job customer's tier (own tier price, else tier 1;
--     a stated $0 counts as a price, as getStatedTierPriceCents in src/lib/quoteCalc.ts).
--   The tier is the customer named in the payload (the impl requires one); a missing customer or
--   tier counts as tier 1.
--
-- HOW: the check runs in the save_job wrapper before the impl, on the chemicals the caller sent,
--   and only for an active admin or sales rep (is_admin() / is_sales_rep(), the roles the impl
--   lets save): any other caller reaches the impl's INSUFFICIENT_ROLE first, so it cannot learn a
--   customer's tier or a product's name from this refusal (rls-security-reviewer M1, 2026-10-23). It is skipped when p_idempotency_key is already on file
--   (unexpired), so a replay of a save that succeeded before this migration is still answered by
--   the impl's receipt, and a different payload under that key is still refused by the impl.
--
-- NOT CHANGED: everything else save_job does (the impl body, its idempotency, unit and total
--   checks; the non-admin cost derivation). Signature, owner (postgres), SECURITY DEFINER,
--   search_path, ACL, OID. Other job_chemicals writers are untouched on purpose:
--   create_job_from_quote_section copies the accepted quote's agreed price, and
--   load_recipe_into_job is no longer called by the app. No rows change.
--
-- CALLERS (every app caller of a function whose behaviour changes here, checked 2026-10-23):
-- caller-analysis: save_job :: JobDetail.tsx; a line whose product states no price must carry a price, else CHEM_PRICE_REQUIRED (the screen already refuses it first)
--
-- LIVE EVIDENCE (read-only, 2026-10-23): save_job(uuid,jsonb,jsonb,jsonb,uuid,text) is the only
--   overload, prosrc md5 (LF) 88ca038686daffbbb2c7a46a05d37e5d; the impl
--   _save_job_cost_step2_impl md5 8acf34542105a90212ddb0a5e7c5d272; EXECUTE postgres,
--   authenticated, service_role. Live job_chemicals: 4 rows on undeleted jobs, 0 of which this
--   check would refuse.
--
-- ROLLBACK: re-emit the previous wrapper body (20261019230000 section 3, md5 above). No data to
--   restore.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE save_job_price_required_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
BEGIN
  -- Under autocommit the ON COMMIT DROP marker is already gone here: refuse before any change.
  IF to_regclass('pg_temp.save_job_price_required_tx') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.save_job_price_required_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'save_job' AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: public.save_job must have exactly one overload';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = to_regprocedure('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)'))
     IS DISTINCT FROM '88ca038686daffbbb2c7a46a05d37e5d' THEN
    -- Already applied, or live drifted from the body this file was written against.
    RAISE EXCEPTION 'SAVE_JOB_BASELINE_DRIFT: public.save_job is not the 2026-10-19 wrapper';
  END IF;
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc
       WHERE oid = to_regprocedure('public._save_job_cost_step2_impl(uuid,jsonb,jsonb,jsonb,uuid,text)'))
     IS DISTINCT FROM '8acf34542105a90212ddb0a5e7c5d272' THEN
    RAISE EXCEPTION 'SAVE_JOB_BASELINE_DRIFT: public._save_job_cost_step2_impl is not the pinned body';
  END IF;
  -- The role gate relies on these being active-only (live bodies 2026-10-23).
  IF (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.is_admin()'))
       IS DISTINCT FROM 'f76bf61116c3bd52bd9c6ea125079b73'
     OR (SELECT md5(replace(prosrc, chr(13), '')) FROM pg_proc WHERE oid = to_regprocedure('public.is_sales_rep()'))
       IS DISTINCT FROM 'fcb3133010fe3f4f56e3be31f709d102' THEN
    RAISE EXCEPTION 'SAVE_JOB_BASELINE_DRIFT: public.is_admin() or public.is_sales_rep() is not the pinned active-only body';
  END IF;
  IF to_regprocedure('public._cost_step2_job_chemicals(uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: public._cost_step2_job_chemicals(uuid,jsonb) is missing';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.save_job(
  p_job_id uuid, p_job_payload jsonb, p_fields jsonb, p_chemicals jsonb,
  p_performed_by uuid, p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_customer_id uuid;
  v_tier integer;
  v_product_name text;
BEGIN
  IF auth.uid() IS NULL OR p_performed_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must match auth.uid()' USING ERRCODE = 'P0001';
  END IF;

  -- A billable line whose product states no price for the job customer's tier cannot be saved at 0
  -- (PR #1060). Only for the active admins and sales reps the impl lets save, so no other caller
  -- learns a customer's tier or a product name here; everyone else gets the impl's refusal.
  -- Skipped for a key already on file: the impl answers a replay from its receipt.
  IF (public.is_admin() OR public.is_sales_rep())
     AND jsonb_typeof(p_chemicals) = 'array'
     AND (p_idempotency_key IS NULL OR NOT EXISTS (
       SELECT 1 FROM idempotency_keys k
        WHERE k.idempotency_key = p_idempotency_key AND k.expires_at >= now())) THEN
    v_customer_id := NULLIF(p_job_payload->>'customer_id', '')::uuid;
    SELECT c.assigned_tier INTO v_tier FROM customers c WHERE c.id = v_customer_id;
    SELECT p.product_name INTO v_product_name
      FROM jsonb_array_elements(p_chemicals) AS e(chem)
      JOIN products p ON p.id = NULLIF(e.chem->>'product_id', '')::uuid
     WHERE NOT COALESCE((e.chem->>'customer_supplied')::boolean, false)
       AND COALESCE(NULLIF(e.chem->>'quantity', '')::numeric, 0) <> 0
       AND COALESCE(NULLIF(e.chem->>'price_per_unit_cents', '')::numeric, 0) = 0
       AND COALESCE(
             CASE COALESCE(v_tier, 1) WHEN 3 THEN p.tier3_price WHEN 2 THEN p.tier2_price ELSE p.tier1_price END,
             p.tier1_price) IS NULL
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION
        'CHEM_PRICE_REQUIRED: % has no price for this customer''s tier, so its line would bill $0. Enter the price per unit, or tick Customer supplied if the grower supplied it.',
        COALESCE(v_product_name, 'A product')
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Cost is admin-only (Mason, 2026-10-15): a non-admin's chemical cost comes from the server.
  -- The impl keeps every check it had (actor, role, units, totals, idempotency).
  IF public.is_admin() THEN
    RETURN public._save_job_cost_step2_impl(
      p_job_id, p_job_payload, p_fields, p_chemicals, p_performed_by, p_idempotency_key);
  END IF;
  RETURN public._save_job_cost_step2_impl(
    p_job_id, p_job_payload, p_fields,
    public._cost_step2_job_chemicals(p_job_id, p_chemicals),
    p_performed_by, p_idempotency_key);
END;
$function$;

DO $postflight$
DECLARE
  v_fn record;
BEGIN
  IF to_regclass('pg_temp.save_job_price_required_tx') IS NULL THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;
  IF (SELECT transaction_id FROM pg_temp.save_job_price_required_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: not the transaction the preflight ran in';
  END IF;
  SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
         md5(replace(p.prosrc, chr(13), '')) AS body_md5
    INTO v_fn
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.save_job(uuid,jsonb,jsonb,jsonb,uuid,text)');
  IF NOT FOUND OR NOT v_fn.prosecdef OR v_fn.owner <> 'postgres'
     OR v_fn.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']
     OR v_fn.acl IS DISTINCT FROM '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
     OR v_fn.body_md5 IS DISTINCT FROM 'c826e0e6455d91706b19de35d1f04f65' THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: public.save_job is not the expected body/attributes (md5 %, acl %)', v_fn.body_md5, v_fn.acl;
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE proname = 'save_job' AND pronamespace = 'public'::regnamespace) <> 1 THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: public.save_job must have exactly one overload';
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: save_job refuses a billable unpriced line at 0';
END;
$postflight$;
