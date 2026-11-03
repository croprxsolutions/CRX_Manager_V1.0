-- Written 2026-11-03. STATUS: NOT APPLIED (local candidate). Apply status is tracked only in
-- docs/reference/migrations.d/20261104160000_draw_quantity_whole_hundredths.md.
-- Re-read the live ledger before applying.
--
-- WHAT (S02, money fix; Mason's order, 2 Nov): a booking drawn as 333.333 gal three times leaves
--   0.001 gal that no draw can take, so the booking never closes (and the three orders bill
--   $12,369.99 for a $12,370.00 booking). Booked quantities are saved to 0.01 (save_quote rounds
--   total_units_needed to 2 places), but a draw quantity had no step. draw_down_quote now refuses a
--   draw quantity with more than 2 decimal places (BOOKING_QUANTITY_PRECISION), so what is left on
--   a booking is always a whole number of hundredths and can always be drawn. 1, 1.5 and 1.50 are
--   fine; 333.333 is refused and nothing is written.
--
-- NOT CHANGED: everything else in draw_down_quote (barrier, actor and role checks, key lock,
--   canonical fingerprint, replay, quote lock, the call into _draw_down_quote_intent_impl_20260819,
--   the receipt binding); the implementation functions; grants. The check runs after the replay,
--   so a retry of a draw committed before this change still returns its order. No table, column,
--   grant or row is added, changed or deleted.
--
-- ROLLBACK (its own reviewed migration): re-emit draw_down_quote from its 20261029110000 body and
--   restore the cost-exposure-review key for draw_down_quote.
--
-- ORDERING: apply after every older pending migration.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE draw_quantity_step_tx ON COMMIT DROP AS
SELECT pg_current_xact_id()::text AS transaction_id;

DO $preflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  IF to_regclass('pg_temp.draw_quantity_step_tx') IS NULL
     OR (SELECT transaction_id FROM pg_temp.draw_quantity_step_tx) IS DISTINCT FROM pg_current_xact_id()::text THEN
    RAISE EXCEPTION 'DRAW_QUANTITY_STEP_NOT_IN_TRANSACTION: apply this file as one transaction';
  END IF;
  -- The re-emitted function, pinned to its current body (20261029110000), owner, mode,
  -- search_path and EXECUTE grants. It has exactly one overload.
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public.draw_down_quote(uuid,jsonb,uuid,text,text)');
  IF NOT FOUND
     OR (SELECT count(*) FROM pg_proc o
          WHERE o.pronamespace = 'public'::regnamespace AND o.proname = 'draw_down_quote') <> 1
     OR md5(replace(p.prosrc, chr(13), '')) IS DISTINCT FROM 'bd23b3e790536948bf5e39496b5e79a1'
     OR p.proowner <> 'postgres'::regrole
     OR NOT p.prosecdef
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
        IS DISTINCT FROM ARRAY['authenticated', 'postgres'] THEN
    RAISE EXCEPTION 'PREFLIGHT_DRAW_DOWN_QUOTE_DRIFT: draw_down_quote differs from its pinned body, owner, mode, search_path or grants';
  END IF;
END
$preflight$;

-- draw_down_quote: the 20261029110000 body plus the DRAW_DOWN_QUANTITY_STEP block after the replay.
CREATE OR REPLACE FUNCTION public.draw_down_quote(p_quote_id uuid, p_draws jsonb, p_performed_by uuid DEFAULT NULL::uuid, p_idempotency_key text DEFAULT NULL::text, p_below_cost_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_canonical_draws jsonb;
  v_fingerprint text;
  v_replay jsonb;
  v_result jsonb;
BEGIN
  -- DRAW_DOWN_INTENT_BARRIER<<<
  -- Keep the cutover barrier first. The preserved private wrapper takes the
  -- same shared lock again, which is safe for the same transaction. This outer
  -- copy prevents intent work from starting while the tier cutover is active.
  IF NOT pg_try_advisory_xact_lock_shared(20260816, 1) THEN
    RAISE EXCEPTION
      'DRAW_DOWN_CUTOVER_IN_PROGRESS: a draw-down maintenance change is being applied right now, so this draw was not recorded. Nothing was changed. Please try again in a moment.';
  END IF;
  -- >>>DRAW_DOWN_INTENT_BARRIER

  -- DRAW_DOWN_INTENT_AUTHZ<<<
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;
  IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'ACTOR_MISMATCH';
  END IF;

  SELECT role
    INTO v_actor_role
    FROM public.profiles
   WHERE id = v_actor
     AND is_active = true;
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('admin', 'sales_rep') THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROLE';
  END IF;
  -- >>>DRAW_DOWN_INTENT_AUTHZ

  -- DRAW_DOWN_INTENT_KEY_LOCK<<<
  -- Take the shared idempotency-key lock before the quote row lock. The helper
  -- below takes the same transaction-scoped lock again before reading the
  -- receipt; PostgreSQL advisory locks are re-entrant for the same session.
  -- This keeps lock order consistent with the helper's other money callers and
  -- prevents a same-key/cross-operation request from forming a key/row cycle.
  IF p_idempotency_key IS NULL
     OR p_idempotency_key COLLATE "C" !~ '^[!-~]{1,200}$' THEN
    RAISE EXCEPTION
      'IDEMPOTENCY_KEY_REQUIRED: draw_down_quote requires p_idempotency_key';
  END IF;
  PERFORM pg_advisory_xact_lock(
    hashtextextended('crx:idempotency:' || p_idempotency_key, 0)
  );
  -- >>>DRAW_DOWN_INTENT_KEY_LOCK

  -- Canonicalize exactly the entries the implementation will execute. Array
  -- order and duplicates remain meaningful because they become separate draw
  -- inputs/order lines; numeric spelling does not (1, 1.0 and 1.00 are one
  -- intent). Invalid/non-positive entries are skipped exactly as the mature
  -- implementation skips them.
  IF p_draws IS NULL
     OR jsonb_typeof(p_draws) <> 'array'
     OR jsonb_array_length(p_draws) = 0 THEN
    RAISE EXCEPTION 'EMPTY_DRAW: no draw lines supplied';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_draws) AS d(value)
     WHERE (d.value ->> 'product_id') IS NOT NULL
       AND NOT pg_input_is_valid(d.value ->> 'product_id', 'uuid')
  ) THEN
    RAISE EXCEPTION
      'BOOKING_PRODUCT_INVALID: draw product id must be a UUID';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_draws) AS d(value)
     WHERE (d.value ->> 'quantity') IS NOT NULL
       AND NOT pg_input_is_valid(d.value ->> 'quantity', 'numeric')
  ) THEN
    RAISE EXCEPTION
      'BOOKING_QUANTITY_INVALID: draw quantity must be numeric';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_draws) AS d(value)
     WHERE (d.value ->> 'quantity') IS NOT NULL
       AND (d.value ->> 'quantity')::numeric IN (
         'NaN'::numeric,
         'Infinity'::numeric,
         '-Infinity'::numeric
       )
  ) THEN
    RAISE EXCEPTION
      'BOOKING_QUANTITY_INVALID: draw quantity must be finite';
  END IF;

  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'product_id', (d.value ->> 'product_id')::uuid,
               'quantity', trim_scale((d.value ->> 'quantity')::numeric)
             )
             -- OVER-DRAW (20261029110000): the rep's price for units over the booking is part of
             -- the request, so a retry that changes it is a different request. Absent = the
             -- fingerprint is exactly what it was before this change.
             || CASE WHEN d.value ? 'extra_price'
                     THEN jsonb_build_object('extra_price', d.value ->> 'extra_price')
                     ELSE '{}'::jsonb END
             ORDER BY d.ordinality
           ),
           '[]'::jsonb
         )
    INTO v_canonical_draws
    FROM jsonb_array_elements(p_draws) WITH ORDINALITY AS d(value, ordinality)
   WHERE (d.value ->> 'product_id') IS NOT NULL
     AND COALESCE((d.value ->> 'quantity')::numeric, 0) > 0;

  IF jsonb_array_length(v_canonical_draws) = 0 THEN
    RAISE EXCEPTION 'EMPTY_DRAW: no draw lines supplied';
  END IF;

  v_fingerprint := encode(
    extensions.digest(
      convert_to(
        jsonb_build_object(
          -- p_performed_by is deliberately absent: the strict ACTOR_MISMATCH
          -- guard above proves it is either NULL or exactly v_actor. If that
          -- guard is ever relaxed, p_performed_by MUST become fingerprint input.
          'actor_id', v_actor,
          'quote_id', p_quote_id,
          'draws', v_canonical_draws
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  -- The shared helper takes a transaction-scoped lock on the key. That closes
  -- same-key races even when two requests name different quote rows.
  -- DRAW_DOWN_INTENT_REPLAY<<<
  v_replay := public.check_idempotency_intent(
    p_idempotency_key,
    'draw_down_quote',
    v_actor,
    v_fingerprint
  );
  IF v_replay IS NOT NULL THEN
    IF v_replay -> 'result' IS NULL
       OR jsonb_typeof(v_replay -> 'result') IS DISTINCT FROM 'object'
       OR NULLIF(v_replay -> 'result' ->> 'order_id', '') IS NULL THEN
      RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
    END IF;
    RETURN v_replay -> 'result';
  END IF;
  -- >>>DRAW_DOWN_INTENT_REPLAY

  -- DRAW_DOWN_QUANTITY_STEP<<< (20261104160000, S02)
  -- A booking's quantities are saved to 0.01 (save_quote rounds them), so a draw must be in whole
  -- hundredths too. Otherwise three draws of 333.333 from 1,000 leave 0.001 that no draw can
  -- take, and the booking never closes. Checked after the replay above, so a retry of a draw
  -- committed before this change still returns its order.
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_draws) AS d(value)
     WHERE (d.value ->> 'product_id') IS NOT NULL
       AND COALESCE((d.value ->> 'quantity')::numeric, 0) > 0
       AND scale(trim_scale((d.value ->> 'quantity')::numeric)) > 2
  ) THEN
    RAISE EXCEPTION
      'BOOKING_QUANTITY_PRECISION: a draw quantity can have at most 2 decimal places (0.01), the same as the booking';
  END IF;
  -- >>>DRAW_DOWN_QUANTITY_STEP

  -- DRAW_DOWN_INTENT_LIVE_QUOTE<<<
  -- A committed receipt is authoritative even if its quote was soft-deleted
  -- after the draw. For a first call, authorize and lock the live booking only
  -- after the exact actor/intent replay check. There is intentionally no
  -- created_by/customer-assignment predicate: active reps may cover one
  -- another's bookings. The inner money implementation takes the same row lock
  -- again before any business write.
  PERFORM 1
    FROM public.quotes
   WHERE id = p_quote_id
     AND deleted_at IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found';
  END IF;
  -- >>>DRAW_DOWN_INTENT_LIVE_QUOTE

  -- This preserved wrapper still owns below-cost approval and forwards to the
  -- tier-split money implementation. p_below_cost_reason is approval metadata,
  -- not mutation identity, so it is deliberately absent from the fingerprint.
  -- DRAW_DOWN_INTENT_FIRST_CALL<<<
  v_result := public._draw_down_quote_intent_impl_20260819(
    p_quote_id,
    p_draws,
    p_performed_by,
    p_idempotency_key,
    p_below_cost_reason
  );

  IF v_result IS NULL
     OR jsonb_typeof(v_result) IS DISTINCT FROM 'object'
     OR NULLIF(v_result ->> 'order_id', '') IS NULL THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RESULT_INVALID';
  END IF;
  -- >>>DRAW_DOWN_INTENT_FIRST_CALL

  -- DRAW_DOWN_INTENT_BIND<<<
  UPDATE public.idempotency_keys
     SET request_fingerprint = v_fingerprint,
         request_actor_id = v_actor
   WHERE idempotency_key = p_idempotency_key
     AND operation = 'draw_down_quote';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'IDEMPOTENCY_RECEIPT_MISSING';
  END IF;
  -- >>>DRAW_DOWN_INTENT_BIND

  RETURN v_result;
END;
$function$
;

DO $postflight$
DECLARE
  p pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO p FROM pg_proc WHERE oid = to_regprocedure('public.draw_down_quote(uuid,jsonb,uuid,text,text)');
  IF NOT FOUND
     OR (SELECT count(*) FROM pg_proc o
          WHERE o.pronamespace = 'public'::regnamespace AND o.proname = 'draw_down_quote') <> 1
     OR position('BOOKING_QUANTITY_PRECISION' IN p.prosrc) = 0
     OR position('DRAW_DOWN_INTENT_REPLAY' IN p.prosrc) > position('DRAW_DOWN_QUANTITY_STEP' IN p.prosrc)
     OR p.proowner <> 'postgres'::regrole
     OR NOT p.prosecdef
     OR p.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
     OR ARRAY(SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' ORDER BY 1)
        IS DISTINCT FROM ARRAY['authenticated', 'postgres'] THEN
    RAISE EXCEPTION 'POSTFLIGHT: draw_down_quote lost its change, owner, mode, search_path or grants';
  END IF;
END
$postflight$;
