-- Quote, order and rebate-claim numbers follow the Chicago business year.
-- Existing identifiers, sequence positions, counter rows, signatures and ACLs are preserved.
-- Number-only sequence allocators retain the documented idempotency exemption from
-- 20260914100100_next_invoice_number_year_chicago.sql; each allocation is intentionally new.
-- create_rebate_claim retains check_idempotency/save_idempotency.
-- Rollback: re-emit the three reviewed prior bodies; never reset counters or renumber rows.
BEGIN;
DO $preflight$
DECLARE
  v_count int;
  v_body text;
BEGIN
  IF to_regprocedure('public.create_rebate_claim(uuid,numeric,bigint,uuid,uuid,uuid,text,text)') IS NULL
     OR to_regprocedure('public.generate_quote_number()') IS NULL
     OR to_regprocedure('public.generate_order_number()') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: numbering signature drift; re-review current definition';
  END IF;
  SELECT count(*), min(md5(replace(prosrc, chr(13), ''))) INTO v_count, v_body
    FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'create_rebate_claim';
  IF v_count <> 1 OR v_body NOT IN ('99e94daf650cffb362a482e532e28694', 'b10a817e3ed45f227c5a471a837b3a4c') THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: create_rebate_claim body or overload drift; re-review current definition';
  END IF;
  SELECT count(*), min(md5(replace(prosrc, chr(13), ''))) INTO v_count, v_body
    FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'generate_order_number';
  IF v_count <> 1 OR v_body NOT IN ('b05ec25cf0acc3788c1d07436876874e', '12ea44c2fab96aa4f3b84becd99aa8cf') THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: generate_order_number body or overload drift; re-review current definition';
  END IF;
  SELECT count(*), min(md5(replace(prosrc, chr(13), ''))) INTO v_count, v_body
    FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'generate_quote_number';
  IF v_count <> 1 OR v_body NOT IN ('43128e5f575b0a23a1941619ee878c93', '997d2761e4ccad424ec37b2eacf9bb60') THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: generate_quote_number body or overload drift; re-review current definition';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.create_rebate_claim(p_program_id uuid, p_quantity numeric, p_claim_amount_cents bigint,
  p_order_id uuid DEFAULT NULL, p_customer_id uuid DEFAULT NULL, p_product_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL, p_idempotency_key text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor       uuid := auth.uid();
  v_year        int := EXTRACT(YEAR FROM (now() AT TIME ZONE 'America/Chicago')::date)::int;
  v_seq         int;
  v_claim_no    text;
  v_claim_id    uuid;
  v_existing    jsonb;
  v_result      jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT (is_admin() OR is_sales_rep()) THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;

  IF p_program_id IS NULL THEN RAISE EXCEPTION 'PROGRAM_REQUIRED'; END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION 'QUANTITY_INVALID'; END IF;
  IF p_claim_amount_cents IS NULL OR p_claim_amount_cents <= 0 THEN
    RAISE EXCEPTION 'CLAIM_AMOUNT_INVALID';
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    v_existing := check_idempotency(p_idempotency_key, 'create_rebate_claim');
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
  END IF;

  INSERT INTO public.rebate_claim_counters (year, next_value)
  VALUES (v_year, 2)
  ON CONFLICT (year) DO UPDATE
    SET next_value = public.rebate_claim_counters.next_value + 1
  RETURNING next_value - 1 INTO v_seq;

  v_claim_no := format('RC-%s-%s', v_year, lpad(v_seq::text, 4, '0'));

  INSERT INTO public.rebate_claims (
    program_id, order_id, customer_id, product_id,
    claim_number, quantity, claim_amount_cents, notes, status,
    created_by
  ) VALUES (
    p_program_id, p_order_id, p_customer_id, p_product_id,
    v_claim_no, p_quantity, p_claim_amount_cents, p_notes, 'pending',
    v_actor
  )
  RETURNING id INTO v_claim_id;

  v_result := jsonb_build_object(
    'success',      true,
    'claim_id',     v_claim_id,
    'claim_number', v_claim_no
  );

  IF p_idempotency_key IS NOT NULL THEN
    PERFORM save_idempotency(p_idempotency_key, 'create_rebate_claim', v_result);
  END IF;

  RETURN v_result;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.generate_order_number()
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  -- Same rule as generate_quote_number.
  IF current_user = 'authenticated' AND NOT public.is_active_profile() THEN
    RAISE EXCEPTION 'PROFILE_INACTIVE: active profile required to take an order number'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF current_user = 'authenticated' AND NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'NUMBER_ROLE_REQUIRED: only an admin or sales rep can take an order number'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN 'ORD-' || extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::text || '-' || lpad(nextval('order_number_seq')::text, 4, '0');
END;
$fn$;

CREATE OR REPLACE FUNCTION public.generate_quote_number()
RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  -- A direct app call needs an active admin or sales rep (Mason: drivers do not take numbers).
  -- SECURITY DEFINER callers run this as their owner, so the checks skip them.
  IF current_user = 'authenticated' AND NOT public.is_active_profile() THEN
    RAISE EXCEPTION 'PROFILE_INACTIVE: active profile required to take a quote number'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF current_user = 'authenticated' AND NOT (public.is_admin() OR public.is_sales_rep()) THEN
    RAISE EXCEPTION 'NUMBER_ROLE_REQUIRED: only an admin or sales rep can take a quote number'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN 'Q-' || extract(year FROM (now() AT TIME ZONE 'America/Chicago')::date)::text || '-' || lpad(nextval('quote_number_seq')::text, 4, '0');
END;
$fn$;

COMMIT;
