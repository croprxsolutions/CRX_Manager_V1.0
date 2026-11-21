-- #1912: adjust_inventory's idempotency-key check only required ONE printable character, so a key such as
-- 'abc' || E'\n' (or one with a tab, a control character or a space) was accepted and stored, although the
-- comment said non-printable keys are refused. It now refuses a key with ANY character outside printable ASCII
-- ('!' to '~'). App keys are '<operation>:<user uuid>:<uuid>' (src/lib/idempotency.ts), so no app call changes.
--
-- Only that one condition (and its comment) changes; the rest of the body is copied unchanged from
-- 20270113100000_stock_checks_negative_onorder_chicago.sql. CREATE OR REPLACE keeps the function's OID, owner,
-- grants, SECURITY DEFINER, search_path, arguments and return type. No table, row, grant or owner changes.
-- Plan: docs/plans/2026-11-19-adjust-inventory-key-printable-CONTRACT.md.
--
-- Safety: the preflight refuses unless the live body is exactly the 20270113100000 body (md5, carriage returns
-- removed), so it cannot apply before that migration and a second apply is refused; the postflight checks the
-- new body and that owner, grants, security mode, settings, return type, volatility and arguments did not move.

CREATE TEMP TABLE adjust_inventory_key_1912_attrs ON COMMIT DROP AS
SELECT p.oid AS fn_oid, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl, p.proconfig,
       p.prorettype, p.provolatile, p.prosecdef, pg_get_function_arguments(p.oid) AS args,
       pg_current_xact_id()::text AS transaction_id
  FROM pg_proc p
 WHERE p.oid = to_regprocedure('public.adjust_inventory(uuid,numeric,text,uuid,text)');

DO $preflight$
DECLARE
  v_md5 text;
BEGIN
  IF (SELECT count(*) FROM pg_temp.adjust_inventory_key_1912_attrs) <> 1 THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: public.adjust_inventory(uuid,numeric,text,uuid,text) is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_temp.adjust_inventory_key_1912_attrs WHERE transaction_id IS DISTINCT FROM pg_current_xact_id()::text) THEN
    RAISE EXCEPTION 'PREFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5
    FROM pg_temp.adjust_inventory_key_1912_attrs a JOIN pg_proc p ON p.oid = a.fn_oid;
  IF v_md5 IS DISTINCT FROM 'f004ee94ab89552797fb34d3f581248d' THEN
    -- Already applied, 20270113100000 not applied yet, or live drifted from that body.
    RAISE EXCEPTION 'ADJUST_INVENTORY_KEY_1912_BASELINE_DRIFT: adjust_inventory body md5 %', v_md5;
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.adjust_inventory(
  p_inventory_id uuid,
  p_delta numeric,
  p_reason text,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $adjust$
DECLARE
  v_actor uuid := auth.uid();
  v_fingerprint text;
  v_replay jsonb;
  v_inv record;
  v_new_qty numeric;
  v_result jsonb;
BEGIN
  -- Who is calling. All of this runs BEFORE any receipt is looked at, so
  -- holding someone else's key is not enough to read their result.
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED: Authentication required';
  END IF;
  -- The caller may name itself or nothing.
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH: p_performed_by must be the signed-in user';
  END IF;
  -- NULL-safe and active-only: a missing or deactivated profile is refused.
  IF NOT EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = v_actor
       AND role = 'admin'
       AND is_active = true
  ) THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE: Only active admins can adjust inventory';
  END IF;

  -- Every adjustment gets a receipt a retry can find. A blank key, or one with
  -- ANY character outside printable ASCII (space, tab, newline, control, non-ASCII),
  -- is refused before any work (#1912).
  IF p_idempotency_key IS NULL
     OR p_idempotency_key !~ '[^[:space:]]'
     OR p_idempotency_key COLLATE "C" ~ '[^!-~]' THEN
    RAISE EXCEPTION 'IDEMPOTENCY_KEY_REQUIRED: adjust_inventory requires p_idempotency_key';
  END IF;

  -- numeric accepts NaN and +/-Infinity. NaN sorts above every number, so it
  -- would pass the negative-stock check below and be written into
  -- quantity_available, which has no CHECK constraint.
  IF p_delta IS NULL
     OR p_delta IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) THEN
    RAISE EXCEPTION 'INVALID_ADJUSTMENT_QUANTITY: the adjustment must be a finite number';
  END IF;
  IF p_delta = 0 THEN
    RAISE EXCEPTION 'Adjustment quantity cannot be zero';
  END IF;

  -- Everything that shapes the adjustment. p_performed_by is left out: the
  -- guard above constrains it to {NULL, actor} and the ledger row is stamped
  -- from auth.uid(), so it cannot change the outcome. That omission DEPENDS on
  -- the ACTOR_MISMATCH guard; if it is ever relaxed, p_performed_by must join
  -- the fingerprint. trim_scale makes 5 and 5.0 the same request.
  v_fingerprint := encode(extensions.digest(convert_to(jsonb_build_object(
    'actor_id', v_actor,
    'inventory_id', p_inventory_id,
    'delta', trim_scale(p_delta),
    'reason', p_reason
  )::text, 'UTF8'), 'sha256'), 'hex');

  -- Takes pg_advisory_xact_lock on the key for the rest of this transaction:
  -- a racing same-key call waits here, then replays. Replays only a receipt
  -- bound to THIS actor and THIS request.
  v_replay := public.check_idempotency_intent(
    p_idempotency_key, 'adjust_inventory', v_actor, v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;

  -- The adjustment itself, unchanged from the live body.
  SELECT * INTO v_inv FROM public.inventory WHERE id = p_inventory_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Inventory record not found';
  END IF;

  v_new_qty := v_inv.quantity_available + p_delta;

  -- C-13: an increase is never refused, so stock below zero can be partly corrected (+5 on -10 gives -5).
  -- A decrease still may not end below zero.
  IF v_new_qty < 0 AND p_delta < 0 THEN
    RAISE EXCEPTION 'Adjustment would result in negative inventory (current: %, delta: %, result: %)',
      v_inv.quantity_available, p_delta, v_new_qty;
  END IF;

  UPDATE public.inventory SET
    quantity_available = v_new_qty,
    updated_at = now()
  WHERE id = p_inventory_id;

  INSERT INTO public.inventory_transactions (
    product_id, transaction_type, quantity,
    to_location, performed_by, notes
  ) VALUES (
    v_inv.product_id, 'adjusted', p_delta,
    v_inv.location, v_actor,
    COALESCE(NULLIF(TRIM(p_reason), ''), 'Manual adjustment of ' || p_delta || ' units')
  );

  v_result := jsonb_build_object(
    'status', 'adjusted',
    'new_quantity', v_new_qty,
    'product_id', v_inv.product_id
  );

  -- The receipt, bound to the actor and the request. No row can exist for this
  -- key here: check_idempotency_intent returned NULL under the advisory lock.
  INSERT INTO public.idempotency_keys (
    idempotency_key, operation, result, request_actor_id, request_fingerprint
  ) VALUES (
    p_idempotency_key, 'adjust_inventory', v_result, v_actor, v_fingerprint
  );

  RETURN v_result;
END;
$adjust$;

DO $postflight$
DECLARE
  v_fn record;
BEGIN
  SELECT md5(replace(p.prosrc, chr(13), '')) AS body_md5, pg_get_userbyid(p.proowner) AS owner,
         p.proacl::text AS acl, p.proconfig, p.prorettype, p.provolatile, p.prosecdef,
         pg_get_function_arguments(p.oid) AS args, a.args AS was_args,
         a.owner AS was_owner, a.acl AS was_acl, a.proconfig AS was_config, a.prorettype AS was_rettype,
         a.provolatile AS was_volatile, a.prosecdef AS was_secdef, a.transaction_id
    INTO v_fn
    FROM pg_temp.adjust_inventory_key_1912_attrs a JOIN pg_proc p ON p.oid = a.fn_oid;
  IF NOT FOUND OR v_fn.transaction_id IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: run this file as one transaction (psql -1 or the apply script)';
  END IF;
  IF v_fn.body_md5 IS DISTINCT FROM 'a65294fccbf7d49375b96ed6c46ab29e'
     OR v_fn.owner IS DISTINCT FROM v_fn.was_owner
     OR v_fn.acl IS DISTINCT FROM v_fn.was_acl
     OR v_fn.proconfig IS DISTINCT FROM v_fn.was_config
     OR v_fn.prorettype IS DISTINCT FROM v_fn.was_rettype
     OR v_fn.provolatile IS DISTINCT FROM v_fn.was_volatile
     OR v_fn.prosecdef IS DISTINCT FROM v_fn.was_secdef
     OR v_fn.args IS DISTINCT FROM v_fn.was_args
     OR NOT v_fn.prosecdef THEN
    RAISE EXCEPTION 'POSTFLIGHT_FAIL: adjust_inventory is not the expected body/attributes (md5 %)', v_fn.body_md5;
  END IF;
  RAISE NOTICE 'POSTFLIGHT_OK: adjust_inventory refuses an idempotency key with any non-printable character';
END;
$postflight$;
