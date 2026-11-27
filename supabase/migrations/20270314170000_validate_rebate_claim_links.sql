-- Local candidate. Validates linked payers and products for both office roles.
-- Existing claim history, optional links, program eligibility and status transitions stay under the existing rules.
-- Restore the pinned wrapper in a reviewed forward migration if rollback is needed.
SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE rebate_claim_link_check_tx ON COMMIT DROP AS
  SELECT pg_current_xact_id() AS transaction_id;

DO $preflight$
BEGIN
  IF to_regclass('pg_temp.rebate_claim_link_check_tx') IS NULL
    OR (SELECT transaction_id FROM pg_temp.rebate_claim_link_check_tx) IS DISTINCT FROM pg_current_xact_id()
  THEN
    RAISE EXCEPTION 'REBATE_CLAIM_LINKS_REQUIRES_TRANSACTION';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
    WHERE oid = to_regprocedure('public.create_rebate_claim(uuid,numeric,bigint,uuid,uuid,uuid,text,text)')
      AND md5(replace(prosrc, chr(13), '')) = 'ce3bd13b9751569baff813a0a4dc1968'
      AND prosecdef AND proowner = 'postgres'::regrole
      AND proconfig = ARRAY['search_path=public, pg_temp']
  ) THEN RAISE EXCEPTION 'REBATE_CLAIM_LINKS_WRAPPER_CHANGED'; END IF;
  IF (SELECT count(*) FROM pg_policy
      WHERE polrelid IN ('public.rebate_claims'::regclass, 'public.rebate_programs'::regclass)
        AND polcmd IN ('r', '*')) <> 2 OR (
    SELECT count(*) FROM pg_policy AS p
    WHERE (p.polrelid, p.polname) IN (
      ('public.rebate_claims'::regclass, 'rebate_claims_select'),
      ('public.rebate_programs'::regclass, 'rebate_programs_select'))
      AND p.polcmd = 'r' AND p.polpermissive
      AND p.polroles IN (ARRAY[0::oid], ARRAY['authenticated'::regrole::oid])
      AND regexp_replace(lower(replace(pg_get_expr(p.polqual, p.polrelid), 'public.', '')), '[()[:space:]]', '', 'g')
          IN ('is_adminoris_sales_rep', 'selectis_adminasis_adminorselectis_sales_repasis_sales_rep')
  ) <> 2 THEN RAISE EXCEPTION 'REBATE_CLAIM_READ_POLICIES_CHANGED'; END IF;
END
$preflight$;

ALTER POLICY rebate_claims_select ON public.rebate_claims TO authenticated
  USING (is_admin() OR (is_sales_rep() AND NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND 'rebates' = ANY(p.denied_pages))));

ALTER POLICY rebate_programs_select ON public.rebate_programs TO authenticated
  USING (is_admin() OR (is_sales_rep() AND NOT EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = (SELECT auth.uid()) AND 'rebates' = ANY(p.denied_pages))));

CREATE OR REPLACE FUNCTION public.create_rebate_claim(
  p_program_id uuid,
  p_quantity numeric,
  p_claim_amount_cents bigint,
  p_order_id uuid DEFAULT NULL::uuid,
  p_customer_id uuid DEFAULT NULL::uuid,
  p_product_id uuid DEFAULT NULL::uuid,
  p_notes text DEFAULT NULL::text,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
  v_order_customer uuid;
  v_is_payer boolean;
  v_program_product uuid;
BEGIN
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: create_rebate_claim requires p_idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
  IF is_sales_rep() AND EXISTS (
    SELECT 1 FROM public.profiles p WHERE p.id = v_actor AND 'rebates' = ANY(p.denied_pages)
  ) THEN RAISE EXCEPTION 'PAGE_ACCESS_DENIED' USING ERRCODE = '42501'; END IF;
  v_fingerprint := public._replay_fingerprint_20261015(jsonb_build_object(
    'actor_id', v_actor, 'program_id', p_program_id, 'quantity', p_quantity,
    'claim_amount_cents', p_claim_amount_cents, 'order_id', p_order_id,
    'customer_id', p_customer_id, 'product_id', p_product_id, 'notes', p_notes));
  v_replay := public.check_idempotency_intent(p_idempotency_key, 'create_rebate_claim', v_actor, v_fingerprint);
  IF v_replay IS NOT NULL AND jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  -- Both roles use the same link rules. Bound retries keep their saved receipt.
  IF v_replay IS NULL THEN
    IF p_product_id IS NOT NULL THEN
      SELECT product_id INTO v_program_product FROM public.rebate_programs
      WHERE id = p_program_id FOR SHARE;
      IF v_program_product IS NOT NULL AND v_program_product IS DISTINCT FROM p_product_id
        AND EXISTS (SELECT 1 FROM public.products WHERE id = p_product_id) THEN
        RAISE EXCEPTION 'REBATE_CLAIM_PROGRAM_PRODUCT_MISMATCH' USING ERRCODE = '22023';
      END IF;
    END IF;

    IF p_order_id IS NOT NULL AND p_customer_id IS NOT NULL THEN
      SELECT customer_id INTO v_order_customer FROM public.orders
      WHERE id = p_order_id FOR SHARE;
      IF FOUND AND EXISTS (SELECT 1 FROM public.customers WHERE id = p_customer_id) THEN
        v_is_payer := v_order_customer = p_customer_id;
        IF public._order_has_bill_split(p_order_id) THEN
          IF EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.order_id = p_order_id) THEN
            SELECT EXISTS (
              SELECT 1 FROM public.order_items oi
              CROSS JOIN LATERAL public._bill_split_line_shares(oi.id, 0, 0) payer
              WHERE oi.order_id = p_order_id AND payer.customer_id = p_customer_id
            ) INTO v_is_payer;
          ELSE
            SELECT COALESCE(bool_or(s.customer_id = p_customer_id), false)
              OR (v_order_customer = p_customer_id AND COALESCE(sum(s.split_percentage), 0) < 100)
              INTO v_is_payer
              FROM public.order_shares s WHERE s.order_id = p_order_id;
          END IF;
        END IF;
        IF v_is_payer IS DISTINCT FROM true THEN
          RAISE EXCEPTION 'REBATE_CLAIM_ORDER_CUSTOMER_MISMATCH' USING ERRCODE = '22023';
        END IF;
      END IF;
    END IF;
  END IF;
  v_result := public._create_rebate_claim_replay_impl_20261015(
    p_program_id, p_quantity, p_claim_amount_cents, p_order_id, p_customer_id, p_product_id,
    p_notes, p_idempotency_key);
  IF v_replay IS NULL THEN
    PERFORM public._bind_replay_receipt_20261015(p_idempotency_key, 'create_rebate_claim', v_fingerprint);
  END IF;
  RETURN v_result;
END;
$function$;

DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
    WHERE oid = 'public.create_rebate_claim(uuid,numeric,bigint,uuid,uuid,uuid,text,text)'::regprocedure
      AND md5(replace(prosrc, chr(13), '')) = 'e4625cf9b4d0fbc525962d2664511b20'
      AND prosecdef AND proowner = 'postgres'::regrole
      AND proconfig = ARRAY['search_path=public, pg_temp']
  ) OR has_function_privilege('anon', 'public.create_rebate_claim(uuid,numeric,bigint,uuid,uuid,uuid,text,text)', 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.create_rebate_claim(uuid,numeric,bigint,uuid,uuid,uuid,text,text)', 'EXECUTE')
    OR NOT has_function_privilege('service_role', 'public.create_rebate_claim(uuid,numeric,bigint,uuid,uuid,uuid,text,text)', 'EXECUTE')
  THEN RAISE EXCEPTION 'REBATE_CLAIM_LINKS_POSTFLIGHT_MISMATCH'; END IF;
END
$postflight$;
